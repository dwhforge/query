cd ..
cd ..
./dbt-venv/bin/python scripts/stress/generate.py \
  --out /app2/stress-test/100k \
  --sales-rows 100000000 \
  --products 100000
