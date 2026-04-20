import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  datasource: {
    url: process.env.DIRECT_DATABASE_URL || env('DATABASE_URL'),
  },
});
