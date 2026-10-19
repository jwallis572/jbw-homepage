// Run the Playwright suite against a deployed URL:
//   BASE_URL=https://<preview>.vercel.app npm run test:preview
//   npm run test:preview -- https://<preview>.vercel.app
// Set VERCEL_AUTOMATION_BYPASS_SECRET if the preview is behind Vercel Deployment Protection.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const urlArg = args.find(a => /^https?:\/\//.test(a));
const baseUrl = urlArg || process.env.BASE_URL;
if (!baseUrl) {
  console.error('Set BASE_URL (or pass the preview URL as an argument).');
  process.exit(1);
}
const rest = args.filter(a => a !== urlArg);
const r = spawnSync('npx', ['playwright', 'test', ...rest], {
  stdio: 'inherit', shell: true, env: { ...process.env, BASE_URL: baseUrl },
});
process.exit(r.status ?? 1);
