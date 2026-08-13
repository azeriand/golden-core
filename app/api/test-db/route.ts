import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const result = await pool.query('SELECT NOW()');

    return NextResponse.json({
      success: true,
      now: result.rows[0].now,
    });
  } catch (error: unknown) {
    const envCheck = {
      DATABASE_URL_set: !!process.env.DATABASE_URL,
      DB_DATABASE_URL_set: !!process.env.DB_DATABASE_URL,
      DB_POSTGRES_URL_set: !!process.env.DB_POSTGRES_URL,
      DB_PGHOST_set: !!process.env.DB_PGHOST,
    };
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        envCheck,
      },
      { status: 500 }
    );
  }
}