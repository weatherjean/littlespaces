// Format feedback is advisory. Only a real service request can verify a credential.
// Never return any characters from the value in a warning.
export function credentialWarnings(name: string, value: string): string[] {
  const warnings: string[] = [];
  if (value !== value.trim())
    warnings.push(
      'The value starts or ends with whitespace. Check the copied credential; whitespace is preserved.',
    );
  if (name === 'GOOGLE_BOOKS_API_KEY' && !/^AIza[A-Za-z0-9_-]{35}$/.test(value))
    warnings.push(
      'This does not match the usual Google Cloud API-key format. Copy the complete API key from Google Cloud Credentials, not its name or ID. Saving it does not verify it.',
    );
  return warnings;
}
