cd ..
cd ..

npm ci
npm run cli:build
cargo build -p dwh-host --release

read -rsp 'OpenCode password: ' OPENCODE_PASSWORD
echo
export OPENCODE_PASSWORD
export DWHQ_ALLOW_SQL=1

node scripts/run-opencode-dwhquery-web.mjs /tmp/dwhq-scale-agent