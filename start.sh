#!/bin/sh

# Exit on error
set -e

echo "Running database migrations..."
npx prisma migrate deploy

# Optionally seed data if the database is empty or we want to ensure latest channels
# echo "Seeding database..."
# npx ts-node prisma/seed_channels.ts

echo "Starting application..."
npm start
