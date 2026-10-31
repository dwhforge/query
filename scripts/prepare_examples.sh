PGPASSWORD=postgres psql -h localhost -U postgres -c 'CREATE DATABASE dwh_tests;'
python3 ./examples/generate_all.py   # если фикстур нет
python3 ./examples/load_postgres.py
