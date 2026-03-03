// ─────────────────────────────────────────────────────────────────────────────
// services/email.js
//
// Thin wrapper around the Resend REST API for transactional emails.
// Falls back to console.log if RESEND_API_KEY is not set (development).
// ─────────────────────────────────────────────────────────────────────────────

const FROM = process.env.FROM_EMAIL || 'MediBook <hello@medibook.io>';

async function send({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL STUB] To: ${to} | Subject: ${subject}`);
    console.log('[EMAIL STUB] (set RESEND_API_KEY to send real emails)');
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });

  if (!res.ok) {
    const msg = await res.text();
    console.error('[EMAIL] Resend error:', msg);
  }
}

// ─── Verification email ────────────────────────────────────────────────────────
export async function sendVerificationEmail({ to, fullName, code }) {
  await send({
    to,
    subject: `${code} is your MediBook verification code`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#faf7f2;padding:40px 32px;border-radius:12px">
        <div style="font-family:Georgia,serif;font-size:26px;color:#0f1419;margin-bottom:8px">Medi<span style="color:#c9903a">Book</span></div>
        <h2 style="font-size:22px;color:#0f1419;margin:24px 0 8px">Hi ${fullName} 👋</h2>
        <p style="color:#5a6474;font-size:15px;line-height:1.7">Thanks for signing up. Enter this code to verify your email address:</p>
        <div style="text-align:center;margin:32px 0;padding:28px;background:#ffffff;border-radius:10px;border:1px solid #e8edf2">
          <span style="font-size:42px;font-weight:700;letter-spacing:12px;color:#c9903a;font-family:monospace">${code}</span>
          <div style="font-size:12px;color:#8896a8;margin-top:10px">Expires in 24 hours</div>
        </div>
        <p style="color:#8896a8;font-size:13px;line-height:1.6">If you didn't sign up for MediBook, you can safely ignore this email.</p>
      </div>
    `,
  });
}

// ─── Onboarding email (sent after Stripe payment — links to token-gated wizard) ─
export async function sendOnboardingEmail({ to, fullName, tenantName, onboardingUrl }) {
  await send({
    to,
    subject: `Welcome to Callora — complete your Med Spa setup`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#0f1419;padding:40px 32px;border-radius:12px">
        <div style="font-family:Georgia,serif;font-size:26px;color:#ffffff;margin-bottom:8px">Cal<span style="color:#c9903a">lora</span></div>
        <h2 style="font-size:22px;color:#ffffff;margin:24px 0 8px">Hi ${fullName} — let's get your Med Spa set up.</h2>
        <p style="color:#94a3b8;font-size:15px;line-height:1.7">
          Payment confirmed. Your <strong style="color:#ffffff">${tenantName}</strong> account is ready.
          Click below to complete your clinic setup — it takes about 5 minutes.
        </p>
        <p style="margin:32px 0;text-align:center">
          <a href="${onboardingUrl}" style="background:#c9903a;color:white;padding:16px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block">
            Complete My Setup →
          </a>
        </p>
        <p style="color:#64748b;font-size:13px;line-height:1.6">
          This link is unique to your account and expires in 72 hours.
          If it expires, simply log in and a new link will be generated automatically.
        </p>
        <hr style="border:none;border-top:1px solid #1e293b;margin:28px 0"/>
        <p style="color:#475569;font-size:12px;line-height:1.6">
          Questions? Reply to this email or contact support@callora.me
        </p>
      </div>
    `,
  });
}

// ─── Welcome email (after trial starts) ───────────────────────────────────────
export async function sendWelcomeEmail({ to, fullName, tenantName, dashboardUrl }) {
  await send({
    to,
    subject: `Welcome to MediBook, ${fullName}! Your 30-day trial has started`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#faf7f2;padding:40px 32px;border-radius:12px">
        <div style="font-family:Georgia,serif;font-size:26px;color:#0f1419;margin-bottom:8px">Medi<span style="color:#c9903a">Book</span></div>
        <h2 style="font-size:22px;color:#0f1419;margin:24px 0 8px">Welcome, ${fullName}! 🎉</h2>
        <p style="color:#5a6474;font-size:15px;line-height:1.7">Your <strong>${tenantName}</strong> account is live. Your 30-day free trial has started — no charges until your trial ends.</p>
        <p style="margin:28px 0">
          <a href="${dashboardUrl}" style="background:#c9903a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Open your dashboard →</a>
        </p>
        <ul style="color:#5a6474;font-size:14px;line-height:2;padding-left:20px">
          <li>Add your services and team members</li>
          <li>Set up your AI voice receptionist</li>
          <li>Share your booking link with clients</li>
        </ul>
        <p style="color:#8896a8;font-size:13px;margin-top:28px;line-height:1.6">Cancel anytime during your trial and you won't be charged. Questions? Reply to this email.</p>
      </div>
    `,
  });
}
