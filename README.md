# Lambda Gem Builder

Hosting a private gem repository to supplement [Rubygems](https://rubygems.org/)
is a hassle: it involves running a dynamic gem server in front of essentially a
static directory of `.gem` files.

This gem builder uses AWS Lambda to run a callback whenever you add a new tag to
your gem on GitHub. It compiles the gem, updates the gem index and uploads those
files up to a dedicated bucket on S3. Point DNS records at your S3 bucket, and
you've got a gem server that stays up to date with your code without any
running moving pieces.

## Contents

1. [Requirements](#requirements)
2. [Configuration](#configuration)
   1. [Create an S3 Bucket](#1-create-an-s3-bucket)
   2. [Security Credentials](#2-security-credentials)
   3. [Lambda Function](#3-lambda-function)
   4. [API Gateway](#4-api-gateway)
   5. [GitHub Webhooks](#5-github-webhooks)
   6. [DNS Settings](#6-dns-settings)
4. [Deploying](#deploying)
5. [Help](#help)
6. [Changelog](#changelog)

## Requirements

Amazon Web Service's [Command Line Interface](https://aws.amazon.com/cli/).
Configure it with `aws configure`, entering your AWS access keys and preferred
region, such as `us-east-1`.

## Configuration

All of these steps can be performed either via AWS's web console, or using the
command line interface. The CLI commands needed to configure your resources
are given first, with the web interface instructions second.

For the command line, set up some configuration variables.

``` bash
export s3_bucket=gems.company.com
export lambda_function_name=gem-builder
role_name=gem-builder-role
api_gateway_name=gem-builder-gateway
kms_alias_name=gem-builder-secrets
```

### 1. Create an S3 Bucket

``` bash
# Make the bucket
aws s3 mb s3://$s3_bucket

# Configure it as a website to serve static traffic
aws s3 website s3://$s3_bucket \
  --index-document index.html \
  --error-document error.html
```

Or in the AWS Console, create an S3 bucket to use as your gem server. It should
be named for the hostname it will act as, e.g. `gems.company.com`.

Under **Properties** for your bucket, select **Static Website Hosting** and
choose **Enable website hosting**.

You can restrict access to an S3 bucket based on IP address, to make your gem
server private. [Bucket Policy Examples](http://docs.aws.amazon.com/AmazonS3/latest/dev/example-bucket-policies.html)

### 2. Security credentials

In the console, these steps are handled under **Security and Identity > IAM** or
**Security Credentials**.

#### Role for Lambda function

``` bash
role_arn=$(aws iam create-role \
  --role-name "$role_name" \
  --assume-role-policy-document file://aws/lambda-role-policy-document.json \
  --output text \
  --query 'Role.Arn')
echo role_arn=$role_arn

# Edit sample policy document to use your preferred s3 bucket name
sed -i '' "s/\(arn:aws:s3:::\)[^\"\/]*/\1$s3_bucket/g" aws/lambda-policy-document.json

# Authorize your role to access S3 + SES
aws iam put-role-policy \
  --role-name "$role_name" \
  --policy-name gem-builder-policy \
  --policy-document file://aws/lambda-policy-document.json
```

Or, select **Roles**, and **Create New Role** in the console.

Give it a name specific to your lambda function, like `lambda-gem-builder`. Under
**AWS Service Roles**, select **AWS Lambda**, and save the role.

View the role, and add a policy to it under **Inline Policies**. This will allow
your function to access certain services on AWS.

Replace `gems.company.com` with the name of your S3 bucket. Include the SES
portion if you want to be notified over email when gems get built.

``` json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:*"
      ],
      "Resource": [
        "arn:aws:s3:::gems.company.com",
        "arn:aws:s3:::gems.company.com/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail"
      ],
      "Resource": [
        "*"
      ]
    }
  ]
}
```

#### KMS Key

``` bash
# Create a new KMS key
key_id=$(aws kms create-key \
  --description "Secrets for $s3_bucket lambda function" \
  --output text \
  --query 'KeyMetadata.KeyId')
echo key_id=$key_id

# Give it a name
aws kms create-alias \
  --alias-name "alias/$kms_alias_name" \
  --target-key-id "$key_id"

# Authorize your lambda function to use the key
aws kms create-grant \
  --key-id "$key_id" \
  --grantee-principal "$role_arn" \
  --operations "Encrypt" "Decrypt"
```

Or select **Encryption Keys**.

Create a new key, and select which users should have access to modify it.

Under **Key Users**, select the role assigned to your lambda function, giving it
permission to use the key.

### 3. Lambda Function

Next, create a new Lambda function.

``` bash
# create deploy.zip to use as the code base for the lambda function
make compile

lambda_function_arn=$(aws lambda create-function \
  --function-name "$lambda_function_name" \
  --runtime "nodejs" \
  --role "$role_arn" \
  --handler "index.handler" \
  --code "S3Bucket=$s3_bucket,S3Key=deploy.zip" \
  --description "Compile Ruby Gems based on a trigger from GitHub" \
  --timeout 60 \
  --memory-size 512 \
  --output 'text' \
  --query 'FunctionArn')
echo lambda_function_arn=$lambda_function_arn
```

If you're in the console, you can skip the **Select blueprint** step since we're
uploading an existing function.

You will have to give the function a unique **name**, and select `Node.js` as
the **Runtime**. Leave the **Handler** as `index.handler` (this means that the
function exported as `handler` from `index.js` will be run in response to events).

Under **Role**, select the role you just created.

I gave the function 512MB of memory and a 1 minute timeout, but you can probably
get away with less.

### 4. API Gateway

Finally, you need to set up a public endpoint that GitHub can hit with a webhook
whenever a new version of your gem is tagged.

``` bash
# Create a new API Gateway
api_id=$(aws apigateway create-rest-api \
  --name "$api_gateway_name" \
  --description "Endpoint hit by GitHub to trigger gem builds" \
  --output 'text' \
  --query 'id')
echo api_id=$api_id

# Get the id of the root resource
root_resource_id=$(aws apigateway get-resources \
  --rest-api-id $api_id \
  --output 'text' \
  --query 'items[0].id')
echo root_resource_id=$root_resource_id

# Create a resource (a path)
resource_id=$(aws apigateway create-resource \
  --rest-api-id $api_id \
  --parent-id $root_resource_id \
  --path-part tags \
  --output 'text'\
  --query 'id')
echo resource_id=$resource_id

# Create a model to represent the response json structure
aws apigateway create-model \
  --rest-api-id $api_id \
  --name 'Hookshot' \
  --content-type 'application/json' \
  --schema '{"$schema":"http://json-schema.org/draft-04/schema#","title":"Error Schema","type":"object","properties":{}}'

# Create a method on that resource
aws apigateway put-method \
  --rest-api-id $api_id \
  --resource-id $resource_id \
  --http-method POST \
  --authorization-type NONE \
  --no-api-key-required \
  --request-models '{"application/json":"Hookshot"}' \
  --cli-input-json '{"requestParameters": {"method.request.header.X-Github-Hookshot": false}}'

# Create an integration
aws apigateway put-integration \
  --rest-api-id $api_id \
  --resource-id $resource_id \
  --http-method POST \
  --integration-http-method POST \
  --type AWS \
  --uri "arn:aws:apigateway:$AWS_REGION:lambda:path/2015-03-31/functions/$lambda_function_arn/invocations" \
  --request-templates '{"application/json": "{\"signature\": \"$input.params('"'"'X-Hub-Signature'"'"')\", \"type\": \"$input.params('"'"'X-GitHub-Event'"'"')\", \"data\": $input.json('"'"'$'"'"')}"}'

# Grant your api permission to invoke the Lambda function
account_id=$(echo $lambda_function_arn | grep -o '\d\{12\}')
aws lambda add-permission \
  --function-name "$lambda_function_name" \
  --statement-id 1 \
  --principal apigateway.amazonaws.com \
  --action lambda:InvokeFunction \
  --source-arn "arn:aws:execute-api:$AWS_REGION:$account_id:$api_id/*/POST/tags"

# Create a public stage GitHub can reach your endpoint at
aws apigateway create-deployment \
  --rest-api-id "$api_id" \
  --stage-name 'prod'
```

> There aren't docs for the Web Console version of this section, but you can
> help out by adding them submitting a pull request!

### 5. GitHub Webhooks

You can set up a webhook to notify the lambda function of new versions of your
gem either for individual repositories, or for all repositories in your
organization.

* `https://github.com/organizations/[ORGANIZATION]/settings/hooks`
* `https://github.com/[OWNER]/[REPOSITORY]/settings/hooks`

I have it set up for our organization so that we don't have to set any configuration
for new gems. The lambda function can tell which repos are gems by checking for
a `.gemspec` in the home directory, and ignores all other repos.

Enter any random string into **Secret**. To find out your endpoint URL, run the
following:

```bash
echo "https://$api_id.execute-api.$AWS_REGION.amazonaws.com/prod/tags"
```

Choose **Let me select individual events**, and check only the **Create**
option. This will trigger your webhook only when a branch (which we'll ignore)
or tag is created.

### 6. DNS Settings

If you're using Route 53, create a new `CNAME` record where the name matches
that of your S3 Bucket.

The value should be the longform hostname of your S3 bucket:

```bash
echo $s3_bucket.s3-website-$AWS_REGION.amazonaws.com
```

## Deploying

#### Configuring Secrets

Some of the configuration needs to be shipped with the deployed code. Because
some of it is sensitive, we encrypt using Amazon's
[Key Management Service](https://aws.amazon.com/kms/) service, and ship only
the encrypted version with the code.

Run the following to encrypt it using the KMS key you set up earlier, saving the
output into `deploy/encrypted-secrets`. Edit the variables to use your
configuration.

* `github_api_token` - access token for GitHub that has read access to your
  repositories
* `github_api_user` - the username your token is associated with
* `github_hookshot_secret` - secret associated with your GitHub webhook, used
  for verifying contents of incoming hooks
* `airbrake_api_key` - (optional)
* `from_email` / `to_email` - (optional) [Simple Email Service](https://console.aws.amazon.com/ses/home)
  settings for sending confirmation emails on successful builds. Confirming
  domains / addresses for emails isn't easy to automate, so go to the console to
  set them up.

```bash
# Change these as needed
github_api_token="$GITHUB_API_TOKEN"
github_api_user="$GITHUB_API_USER"
github_hookshot_secret="1234567890"
# optional
airbrake_api_key=""
from_email=""
to_email=""

aws kms encrypt \
  --key-id $key_id \
  --plaintext "{\"github_api_token\":\"$github_api_token\", \"github_hookshot_secret\":\"$github_hookshot_secret\", \"github_api_user\": \"$github_api_user\", \"s3_bucket\": \"$s3_bucket\", \"airbrake_api_key\": \"$airbrake_api_key\", \"from_email\": \"$from_email\", \"to_email\": \"$to_email\"}" \
  --query CiphertextBlob \
  --output text \
  --region us-east-1 | base64 -D > deploy/encrypted-secrets
```

#### Updating Lambda Function

Before the first time your function runs, you'll need to upload the compiled
version of ruby to your S3 bucket with the following. It's not packaged with
your function code because AWS limits the total size of your functions, so we
want to keep the footprint to a minimum.

```bash
aws s3 cp ruby_ship.tar.gz "s3://$s3_bucket/ruby_ship.tar.gz" \
  --grants read=uri=http://acs.amazonaws.com/groups/global/AllUsers
```

Or, save it directly to the bucket at `s3://[BUCKET]/ruby_ship.tar.gz`.

Finally, run `make update` to package up the files along with your secrets, and
deploy them to your lambda function.

### Logging

To help with any issues that come up, you can enable logging for both the API
Gateway and the Lambda function.

> There aren't docs for the Web Console version of this section, but you can
> help out by adding them submitting a pull request!

### Test it out

Create a new tag for one of your gems with an active webhook. If all goes as
planned, the **Monitoring** tab of your Lambda function should indicate the
function has been called.

## Help

### Compiling Ruby

Lambda function's don't support Ruby applications natively, so we have to
compile and ship a version of ruby for AWS's infrastructure as part of our
script.

A compiled version of ruby `2.2.3` that works on Lambdas's infrastructure as of
December 2015 is included in the repo as ruby_ship.tar.gz. If you need a
different version of Ruby, or the AMI that lambda uses changes, you can follow
these instructions to compile Ruby from scratch.

http://docs.aws.amazon.com/lambda/latest/dg/current-supported-versions.html

Should be done using the same AMI that Amazon uses to run lambda processes.
This AMI is for `us-east-1`, but there are others for other regions.

`ami-1ecae776` / `m3.medium`

Connect to the EC2 instance, and install some dependencies required for
building ruby. These are not required to be present on the runtime lambda
instance.

`ssh -i ~/.ssh/[privatekey].pem ec2-user@[HOSTNAME]`

`sudo yum -y install git gcc zlib-devel`

Download your preferred version of ruby and the `ruby_ship` library from
GitHub. Then build it and compress the resulting `bin` folder.

``` bash
git clone git@github.com:stephan-nordnes-eriksen/ruby_ship.git
curl -O https://cache.ruby-lang.org/pub/ruby/2.2/ruby-2.2.3.tar.gz

./ruby_ship/tools/ruby_ship_build.sh ruby-2.2.3.tar.gz

# You can remove some of the contents of `bin/` before compressing to decrease
# file size, such as all of the non-linux versions in `bin/shipyard/`.

tar -czvf ruby_ship.tgz ruby_ship/bin
```

Back on your machine, download the compiled version of ruby.

`scp ec2-user@[HOSTNAME]:/home/ec2-user/ruby_ship.tgz .`

You can now upload this file to your gemserver's S3 bucket.

### Updating an existing tag

By default, a build is triggered only when a tag is first created. If you want
to re-build a version of a gem for which a tag already exists, you can quickly
delete + recreate a tag with the following script:

``` bash
tag=vX.X.X
git fetch origin
tag_ref=$(git show-ref refs/tags/$tag | awk '{print $1}')
git tag -d $tag
git push origin :refs/tags/$tag
git tag $tag $tag_ref
git push origin --tags
```

## Changelog

#### `0.1.0`

December 30, 2015. Initial Release.

## License

With the exception of code contained in `deploy/vendor` and `ruby_ship.tar.gz`,
this repository is released under the Apache 2.0 License.

## Authors

Created by [Michael Strickland](https://twitter.com/moriogawa) for the
Interactive News team at The New York Times.
