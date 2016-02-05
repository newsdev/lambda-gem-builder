compile:
	cd deploy; npm install; zip -r ../deploy.zip .
	aws s3 cp deploy.zip s3://$(s3_bucket)/deploy.zip --grants read=uri=http://acs.amazonaws.com/groups/global/AllUsers

update:
	make compile
	aws lambda update-function-code --function-name $(lambda_function_name) --zip-file fileb://deploy.zip --region $(AWS_REGION)
	rm deploy.zip
