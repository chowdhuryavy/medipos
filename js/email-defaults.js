// Default email texts. The server (server/templates.js) uses these too, so both stay in step.
// Placeholders: {{name}} {{email}} {{password}} {{code}} {{appName}} {{shopName}} {{loginUrl}}
export const EMAIL_PLACEHOLDERS = ["name", "email", "password", "code", "appName", "shopName", "loginUrl"];

export const DEFAULT_TEMPLATES = {
  otp: {
    label: "Password reset code",
    help: "Sent when someone asks to reset their password. Keep {{code}} in the body.",
    subject: "Your {{appName}} verification code: {{code}}",
    body: "Hello {{name}},\n\nUse this verification code to reset your password:\n\n{{code}}\n\nThe code expires in 10 minutes. If you did not ask for a reset, you can ignore this email.",
    button: "",
  },
  welcome: {
    label: "New staff account",
    help: "Sent when an administrator creates a staff login. Include {{email}} and {{password}}.",
    subject: "Welcome to {{appName}}: your account is ready",
    body: "Hello {{name}},\n\nYour {{appName}} account for {{shopName}} is ready.\n\nEmail: {{email}}\nTemporary password: {{password}}\n\nYou must change this password the first time you sign in.",
    button: "Sign in to {{appName}}",
  },
  reset: {
    label: "Password reset by administrator",
    help: "Sent when an administrator resets someone's password. Include {{email}} and {{password}}.",
    subject: "Your {{appName}} password was reset",
    body: "Hello {{name}},\n\nAn administrator reset your password.\n\nEmail: {{email}}\nTemporary password: {{password}}\n\nYou must change this password when you sign in.",
    button: "Sign in to {{appName}}",
  },
};
