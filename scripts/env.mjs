import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
// Explicit environment variables take precedence over the installation's .env.
if (existsSync('.env')) loadEnvFile('.env');
