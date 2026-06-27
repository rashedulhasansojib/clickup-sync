import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock } from 'lucide-react';
import { authApi } from '../api/auth';
import { useAuth } from '../hooks/useAuth';
import {
  AuthShell, AuthCard, AuthHeading, AuthField, AuthSubmit, SSOButton, Divider, BrandMark,
} from '../components/auth/AuthShell';
import { Switch } from '../components/ui/Switch';
import { isEmail } from '../lib/validation';
import { safeMeetsyRedirect } from '../lib/redirect';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { refresh, user } = useAuth();

  useEffect(() => {
    if (user) {
      // Already authenticated: honor a safe Meetsy round-trip, else go to Overview.
      const redirect = safeMeetsyRedirect();
      if (redirect) window.location.href = redirect;
      else navigate('/overview', { replace: true });
    }
  }, [user, navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password');
      return;
    }
    if (!isEmail(email)) {
      setError('Enter a valid email address');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await authApi.login(email.trim(), password);
      await refresh();
      // Cross-subdomain Meetsy return needs a full-page nav (not react-router).
      const redirect = safeMeetsyRedirect();
      if (redirect) window.location.href = redirect;
      else navigate('/overview', { replace: true });
    } catch {
      setError('Invalid email or password');
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}><BrandMark /></div>
      <AuthCard>
        <AuthHeading title="Sign in" subtitle="Welcome back. Sign in to your workspace." />
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SSOButton>Continue with Google</SSOButton>
          <Divider label="or" />
          <AuthField
            label="Work email" type="email" name="email" icon={Mail} autoComplete="email" autoFocus
            value={email} onChange={(e) => { setEmail(e.target.value); setError(''); }}
            placeholder="you@company.com"
            error={error || undefined}
          />
          <AuthField
            label="Password" type="password" name="password" icon={Lock} autoComplete="current-password"
            value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }}
            placeholder="••••••••"
            right={<span title="Password reset is coming soon" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-faint)', cursor: 'default' }}>Forgot?</span>}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
            <Switch checked={keep} onChange={setKeep} /> Keep me signed in
          </label>
          <AuthSubmit loading={loading}>Sign in</AuthSubmit>
        </form>
      </AuthCard>
      <p style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-muted)', marginTop: 18 }}>
        New to Clicksy?{' '}
        <button onClick={() => navigate('/signup')} style={{ background: 'none', border: 0, padding: 0, fontSize: 13, fontWeight: 600, color: 'var(--accent-strong)', cursor: 'pointer' }}>Create an account</button>
      </p>
    </AuthShell>
  );
}
