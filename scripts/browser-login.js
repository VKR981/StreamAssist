// Local helper used by the build chat to start sign-in without token copying.
// Only public activation details and the authorized account name reach stdout.
import { DeviceAuthFlow } from '../src/twitch/device-auth.js';
const flow = new DeviceAuthFlow();
process.on('SIGINT', () => { flow.cancel(); process.exit(130); });
process.on('SIGTERM', () => { flow.cancel(); process.exit(143); });
try {
  const started = await flow.begin();
  console.log(JSON.stringify(started));
  while (Date.now() < started.expires_at) {
    const result = await flow.complete({ waitSeconds: 20 });
    if (result.status === 'authorized') {
      console.log(JSON.stringify({ status: 'authorized', login: result.login, user_id: result.user_id }));
      process.exit(0);
    }
    if (result.status !== 'pending') {
      console.log(JSON.stringify(result));
      process.exit(1);
    }
  }
  flow.cancel();
  console.log(JSON.stringify({ status: 'expired', message: 'Start sign-in again.' }));
  process.exitCode = 1;
} catch {
  flow.cancel();
  console.error('Twitch sign-in could not start. Check the application is registered as a Public client and try again.');
  process.exitCode = 1;
}
