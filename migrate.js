const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://kilo_baseball_db_v2_user:GG5QP5HqqFQNB1pUp0nZcsGtRx8vSjxk@dpg-d97gpsnaqgkc73egdrkg-a.oregon-postgres.render.com/kilo_baseball_db_v2',
  ssl: {
    rejectUnauthorized: false
  }
});

async function migrate() {
  try {
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS balls INT DEFAULT 0;');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS strikes INT DEFAULT 0;');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS spin_rate INT;');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS ivb DECIMAL(5,2);');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS hb DECIMAL(5,2);');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS batter_handedness VARCHAR(3);');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS pitch_outcome_details VARCHAR(100);');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS exit_velocity INT;');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS pitcher_id UUID;');
    await pool.query('CREATE TABLE IF NOT EXISTS pitchers (id UUID PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS extension DECIMAL(5,2);');
    await pool.query('ALTER TABLE pitches ADD COLUMN IF NOT EXISTS csv_import_id UUID REFERENCES csv_imports(id);');
    
    // Create csv_imports table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS csv_imports (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES sessions(id),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        pitch_count INT DEFAULT 0,
        pitcher_count INT DEFAULT 0
      );
    `);

    await pool.query('ALTER TABLE pitchers ADD COLUMN IF NOT EXISTS pitcher_throws VARCHAR(10);'); 
    console.log('✅ All columns added!');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

migrate();