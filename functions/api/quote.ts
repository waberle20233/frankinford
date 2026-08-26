interface Env {
  TURNSTILE_SECRET_KEY: string;
  RESEND_API_KEY: string;
  QUOTE_ALERT_TO: string;
  QUOTE_ALERT_FROM: string;
}

interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
}

const jsonResponse = (body: Record<string, unknown>, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function verifyTurnstile(token: string, secret: string, ip: string | null): Promise<boolean> {
  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  if (ip) formData.append('remoteip', ip);

  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });

  const outcome = (await result.json()) as TurnstileResponse;
  return outcome.success === true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ success: false, message: 'Invalid form submission.' }, 400);
  }

  const turnstileToken = form.get('cf-turnstile-response');
  if (typeof turnstileToken !== 'string' || !turnstileToken) {
    return jsonResponse({ success: false, message: 'Verification failed. Please try again.' }, 400);
  }

  const clientIp = request.headers.get('CF-Connecting-IP');
  const isHuman = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, clientIp);
  if (!isHuman) {
    return jsonResponse({ success: false, message: 'Verification failed. Please try again.' }, 400);
  }

  const name = form.get('name');
  const contact = form.get('contact');
  const vehicleYear = form.get('vehicleYear');
  const vehicleMake = form.get('vehicleMake');
  const vehicleModel = form.get('vehicleModel');
  const condition = form.get('condition');
  const budget = form.get('budget');
  const details = form.get('details');
  const scope = form.getAll('scope').filter((value): value is string => typeof value === 'string');

  const requiredFields = { name, contact, vehicleYear, vehicleMake, vehicleModel, condition, budget, details };
  for (const [field, value] of Object.entries(requiredFields)) {
    if (typeof value !== 'string' || !value.trim()) {
      return jsonResponse({ success: false, message: `Missing required field: ${field}` }, 400);
    }
  }

  const fields = requiredFields as Record<keyof typeof requiredFields, string>;

  const summaryRows = [
    ['Name', fields.name],
    ['Contact', fields.contact],
    ['Vehicle', `${fields.vehicleYear} ${fields.vehicleMake} ${fields.vehicleModel}`],
    ['Condition', fields.condition],
    ['Scope of Work', scope.join(', ') || 'Not specified'],
    ['Target Budget', fields.budget],
    ['Project Details', fields.details],
  ];

  const emailHtml = `
    <h2>New FrankinFord Fabrications Quote Request</h2>
    <table cellpadding="6" cellspacing="0" border="0">
      ${summaryRows
        .map(
          ([label, value]) =>
            `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(value).replace(/\n/g, '<br />')}</td></tr>`
        )
        .join('')}
    </table>
  `;

  try {
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.QUOTE_ALERT_FROM,
        to: env.QUOTE_ALERT_TO,
        subject: `New Quote Request: ${fields.vehicleYear} ${fields.vehicleMake} ${fields.vehicleModel}`,
        html: emailHtml,
        reply_to: fields.contact.includes('@') ? fields.contact : undefined,
      }),
    });

    if (!emailResponse.ok) {
      const errorBody = await emailResponse.text();
      console.error('Resend API error:', errorBody);
      return jsonResponse(
        { success: false, message: 'Request received, but the alert email failed to send. We still have your info on file.' },
        502
      );
    }
  } catch (error) {
    console.error('Failed to send quote alert email:', error);
    return jsonResponse(
      { success: false, message: 'Request received, but the alert email failed to send. We still have your info on file.' },
      502
    );
  }

  return jsonResponse({ success: true, message: 'Quote request received.' }, 200);
};

export const onRequestGet: PagesFunction = async () => {
  return jsonResponse({ success: false, message: 'Method not allowed.' }, 405);
};
