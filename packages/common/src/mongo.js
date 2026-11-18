import { MongoClient } from 'mongodb';

/**
 * Database-per-service: every service connects to the same server but its own
 * database, so no service ever reads another service's collections.
 */
export async function connectMongo(url, dbName) {
  const client = new MongoClient(url, { maxPoolSize: 20, serverSelectionTimeoutMS: 10000 });
  await client.connect();
  return { client, db: client.db(dbName) };
}

export const isDuplicateKey = (err) => err?.code === 11000;
