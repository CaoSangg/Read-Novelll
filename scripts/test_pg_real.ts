import { query, getClient, pool } from "../src/lib/db/pool";

async function main() {
  console.log("=== POSTGRESQL REAL CONNECTION TEST ===");

  // TEST 1: Ket noi PostgreSQL that
  const db = await query<{ db_name: string }>(
    "SELECT current_database() AS db_name"
  );

  const dbName = db.rows[0].db_name;

  if (dbName !== "readnovel_step2_verify") {
    throw new Error("Wrong database: " + dbName);
  }

  console.log("[PASS] Connected to:", dbName);

  // TEST 2: Dem 11 bang
  const tables = await query<{ total: number }>(`
    SELECT COUNT(*)::int AS total
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
  `);

  if (tables.rows[0].total !== 11) {
    throw new Error("Expected 11 tables");
  }

  console.log("[PASS] Tables:", tables.rows[0].total);

  // TEST 3: Kiem tra pgvector va pg_trgm
  const extensions = await query<{ extname: string }>(`
    SELECT extname FROM pg_extension
    WHERE extname IN ('vector', 'pg_trgm')
  `);

  const names = extensions.rows.map(r => r.extname);

  if (!names.includes("vector") || !names.includes("pg_trgm")) {
    throw new Error("Missing PostgreSQL extensions");
  }

  console.log("[PASS] Extensions:", names.join(", "));

  // TEST 4: Connection Pool + Transaction
  const client = await getClient();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      "SELECT 1::int AS value"
    );

    if (result.rows[0].value !== 1) {
      throw new Error("Transaction query failed");
    }

    await client.query("COMMIT");

    console.log("[PASS] Transaction BEGIN/COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.log("=== ALL REAL DATABASE TESTS PASSED ===");
}

main()
  .catch((error) => {
    console.error("[FAIL]", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
