import { useState } from 'react';
import { Button, Input, Label, Spinner, useToastContext } from '@librechat/client';
import type { FormEvent } from 'react';
import { submitVectoreePassword } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function VectoreePassword() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setMessage(localize('com_auth_vectoree_password_min8'));
      return;
    }
    if (password.length > 128) {
      setMessage(localize('com_auth_password_max_length'));
      return;
    }
    if (password !== confirmPassword) {
      setMessage(localize('com_auth_vectoree_password_mismatch'));
      return;
    }
    if (codeSent && !/^\d{6}$/.test(code.trim())) {
      setMessage(localize('com_auth_vectoree_password_code_sent'));
      return;
    }

    setSubmitting(true);
    setMessage(null);
    try {
      const result = await submitVectoreePassword({
        password,
        confirmPassword,
        ...(codeSent ? { code: code.trim() } : {}),
      });
      if (!result.ok) {
        throw new Error(result.message || localize('com_auth_vectoree_reset_failed'));
      }
      if (result.codeSent) {
        setCodeSent(true);
        setMessage(localize('com_auth_vectoree_password_code_sent'));
        return;
      }
      setPassword('');
      setConfirmPassword('');
      setCode('');
      setCodeSent(false);
      showToast({ message: localize('com_auth_vectoree_password_saved'), status: 'success' });
    } catch (error) {
      const fallback = localize('com_auth_vectoree_reset_failed');
      setMessage(error instanceof Error ? error.message : fallback);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex max-w-sm flex-col gap-3" onSubmit={onSubmit}>
      <div>
        <p className="text-sm text-text-primary">{localize('com_auth_vectoree_set_password')}</p>
        <p className="mt-1 text-xs text-text-secondary">
          {localize('com_auth_vectoree_set_password_hint')}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="vectoree-new-password" className="text-xs text-text-secondary">
          {localize('com_auth_vectoree_password_new')}
        </Label>
        <Input
          id="vectoree-new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          minLength={8}
          maxLength={128}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="vectoree-confirm-password" className="text-xs text-text-secondary">
          {localize('com_auth_vectoree_password_confirm')}
        </Label>
        <Input
          id="vectoree-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          minLength={8}
          maxLength={128}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
        />
      </div>
      {codeSent ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="vectoree-password-code" className="text-xs text-text-secondary">
            {localize('com_auth_vectoree_reset_code')}
          </Label>
          <Input
            id="vectoree-password-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            minLength={6}
            maxLength={6}
            pattern="[0-9]{6}"
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </div>
      ) : null}
      {message ? (
        <p className="text-xs text-text-secondary" role="status">
          {message}
        </p>
      ) : null}
      <Button type="submit" variant="submit" disabled={submitting} className="w-fit">
        {submitting ? <Spinner className="size-4" /> : localize('com_auth_continue')}
      </Button>
    </form>
  );
}
