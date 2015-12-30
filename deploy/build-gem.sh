#!/bin/bash
set -e
cd /tmp

echo "Extracting ruby_ship"
tar -xzf /tmp/gemserver/ruby_ship.tar.gz
rm /tmp/gemserver/ruby_ship.tar.gz
echo "Done extracting ruby_ship"

archive_url="https://api.github.com/repos/$owner/$repo/tarball/$tag?access_token=$github_api_token"
headers=$(curl -sLI $archive_url)
filename=$(printf "$headers" | grep -o -E 'filename=.*$' | sed -e 's/filename=//' | sed -e 's/\.tar\.gz.*/.tar.gz/')
curl -s -L $archive_url > /tmp/$filename
echo "Done downloading."

echo "Extracting archive"
tar -xzf /tmp/$filename
echo "Done extracting archive"

gem_folder=/tmp/$(tar -ztf /tmp/$filename | head -1)
rm /tmp/$filename

cd $gem_folder

# Make git available on the command line during the gem build, to allow use of
# `git ls-files` as is common in `.gemspec`s.
git init
git add -A

echo "Building gem"
echo $(/tmp/bin/ruby_ship_gem.sh build $repo.gemspec) > /tmp/build
mkdir -p /tmp/gemserver/gems
mkdir -p /tmp/gemserver/quick/Marshal.4.8
mv $gem_folder/$repo-*.gem /tmp/gemserver/gems
echo "Done building gem"

echo "Generating index"
/tmp/bin/ruby_ship_gem.sh install --local --no-ri --no-rdoc /var/task/vendor/builder-3.2.2.gem
if [ -e "/tmp/gemserver/specs.4.8" ]
  then /tmp/bin/ruby_ship_gem.sh generate_index --directory /tmp/gemserver --update
  else /tmp/bin/ruby_ship_gem.sh generate_index --directory /tmp/gemserver
fi
echo "Done generating index"

find /tmp/gemserver/ -type f -name "*" > /tmp/files
