"""Shared SQL quoting, deterministic hash expression, and atomic manifest writes."""
import json
import os

def sqlstr(value):
    return "\'" + str(value).replace("\'", "\'\'") + "\'"

def h(expr,salt,seed):
    return f"hash({expr}, {sqlstr(salt)}, {seed})"

def save_json(path,value):
    tmp=path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value,indent=2),encoding="utf8")
    os.replace(tmp,path)
