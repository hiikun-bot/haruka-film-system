const {
  normalizePrivateKey,
  normalizeCredentials,
  inspectCredentials,
} = require('../lib/google-service-account');

describe('google-service-account', () => {
  const pem = [
    '-----BEGIN PRIVATE KEY-----',
    'abc',
    '-----END PRIVATE KEY-----',
    '',
  ].join('\n');

  test('normalizes literal backslash-n in private_key', () => {
    const escaped = pem.replace(/\n/g, '\\n');
    expect(normalizePrivateKey(escaped)).toBe(pem);
    expect(normalizeCredentials({ private_key: escaped }).private_key).toBe(pem);
  });

  test('reports normalized credential health without exposing private key body', () => {
    const escaped = pem.replace(/\n/g, '\\n');
    const credentials = normalizeCredentials({
      client_email: 'svc@example.iam.gserviceaccount.com',
      private_key_id: '1234567890abcdef',
      private_key: escaped,
    });

    const diagnostics = inspectCredentials(credentials, { rawEnv: JSON.stringify({ private_key: escaped }) });
    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.client_email).toBe('svc@example.iam.gserviceaccount.com');
    expect(diagnostics.private_key_id).toBe('12345678...(16)');
    expect(JSON.stringify(diagnostics)).not.toContain('abc');
  });
});
