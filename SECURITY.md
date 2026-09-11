# Security

This is a **public repository**. Treat every committed file as immediately public.

## Never commit

- API keys or access tokens
- passwords
- OAuth client secrets
- private keys or certificates
- cloud/service-account credential files
- `.env`, `.dev.vars`, or similar local secret files
- production configuration containing credentials

## How to handle secrets

Use local environment files only for development and keep them ignored by Git. For deployment, use the secret/environment-variable store provided by the hosting platform.

Commit only placeholder variable names to `.env.example`; never put real values there.

Before each push, review staged changes:

```bash
git diff --cached
```

Also check that ignored secret files are not already tracked:

```bash
git ls-files | grep -E '(^|/)(\.env($|\.)|\.dev\.vars($|\.)|credentials.*\.json$|service[-_]account.*\.json$)|\.(pem|key|p12|pfx|jks|keystore)$'
```

## If a secret is committed

1. Revoke or rotate the credential immediately.
2. Remove it from the repository and Git history if necessary.
3. Do not assume that deleting it in a later commit makes the leaked credential safe.

## GitHub settings

For this public repository, enable GitHub secret scanning and push protection where available.
