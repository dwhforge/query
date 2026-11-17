cd ..
cd ..

npm ci
npm run cli:build
cargo build -p dwh-host --release

mkdir -p /tmp/dwhq-business-test
cp examples/opencode-sales/*.csv /tmp/dwhq-business-test/

node scripts/install-opencode-dwhquery.mjs /tmp/dwhq-business-test



read -rsp 'OpenCode password: ' OPENCODE_PASSWORD
echo
export OPENCODE_PASSWORD

node scripts/run-opencode-dwhquery-web.mjs /tmp/dwhq-business-test