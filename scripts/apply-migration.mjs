import { readFileSync } from "node:fs";

const token = readFileSync(process.env.SB_TOKEN_FILE, "utf8").trim();
const sql = readFileSync(process.argv[2], "utf8");

const res = await fetch(
  "https://api.supabase.com/v1/projects/mjvlczaytkhvsolnhhkz/database/query",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  },
);

const body = await res.text();
console.log(res.status);
console.log(body);
