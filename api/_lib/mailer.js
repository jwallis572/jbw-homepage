// Lockout / reset emails via Resend's HTTP API. Tests inject a fake with the same send() shape.
// The recipient always comes from ALERT_EMAIL, never from a request. Nothing here is logged.

export function createResendMailer({ apiKey, from, fetch = globalThis.fetch }) {
  return {
    async send({ to, subject, text }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`resend failed: ${res.status}`);
    },
  };
}

/** Subject + body for each reason a reset link goes out. */
export function resetEmail(reason, link) {
  const expiry = 'The link works once and expires in 30 minutes.';
  if (reason === 'lockout') {
    return {
      subject: 'Projects dashboard locked after 5 wrong PINs',
      text: `Someone entered 5 wrong PINs on your Projects dashboard, so it is now locked.\n\n`
        + `If that wasn't you, someone may be guessing your PIN. To set a new PIN and unlock:\n${link}\n\n${expiry}\n`,
    };
  }
  if (reason === 'setup') {
    return {
      subject: 'Set up your Projects dashboard PIN',
      text: `Use this link to set your 4-digit PIN:\n${link}\n\n${expiry}\n`,
    };
  }
  return {
    subject: 'Reset your Projects dashboard PIN',
    text: `A PIN reset was requested. To set a new 4-digit PIN:\n${link}\n\n${expiry}\n`
      + `If you didn't ask for this, you can ignore this email.\n`,
  };
}
