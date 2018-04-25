#!/bin/bash

rm -rf node_modules
npm install --production
rm -f SHA256SUMS
shasum -a 256 package.json *.js LICENSE > SHA256SUMS
find node_modules -type f -exec shasum -a 256 {} \; >> SHA256SUMS
TARFILE=$(npm pack)
tar xzf ${TARFILE}
cp -r node_modules ./package
tar czf ${TARFILE} package
rm -rf package
echo "Created ${TARFILE}"
