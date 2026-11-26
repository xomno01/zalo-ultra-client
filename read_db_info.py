import sqlite3
import os

paths = {
    "1489069764014589747": r"D:\Zalo Data\message\Database\_production\1489069764014589747",
    "2132859265739813562": r"D:\Zalo_Test_Env\AppData\Roaming\ZaloData\Database\_production\2132859265739813562",
    "614370275596490287": r"D:\Zalo_Test_Env\AppData\Roaming\ZaloData\Database\_production\614370275596490287"
}

for uid, p in paths.items():
    print(f"\n--- Checking UID: {uid} ---")
    meta_db = os.path.join(p, "Meta.db")
    if os.path.exists(meta_db):
        try:
            conn = sqlite3.connect(meta_db)
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
            tables = [row[0] for row in cur.fetchall()]
            print("Meta.db tables:", tables)
            for t in tables:
                cur.execute(f"SELECT * FROM {t} LIMIT 3;")
                print(f"Table {t} sample:", cur.fetchall())
            conn.close()
        except Exception as e:
            print("Error reading Meta.db:", e)
    else:
        print("Meta.db not found at", meta_db)
