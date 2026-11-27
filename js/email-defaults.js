// Default email texts and settings. The server (server/templates.js, server/otp-email.js) uses these too.
// Placeholders: {{name}} {{email}} {{password}} {{code}} {{minutes}} {{appName}} {{shopName}} {{loginUrl}}
export const EMAIL_PLACEHOLDERS = ["name", "email", "password", "code", "minutes", "appName", "shopName", "loginUrl"];

export const DEFAULT_EMAIL_FOOTER = "This is an automated message. Please do not reply.";
export const DEFAULT_OTP_MINUTES = 10;
export const DEFAULT_BRAND_COLOR = "#0f766e";

export const DEFAULT_TEMPLATES = {
  otp: {
    label: "Password reset code",
    help: "Sent when someone asks to reset their password. The code is always shown in its own box after the label text. Keep “Your verification code is” so Gmail can detect the code.",
    subject: "Your verification code {{code}} – {{shopName}}",
    eyebrow: "Security",
    heading: "Password reset request",
    greeting: "Hello {{name}},",
    intro: "We received a request to reset the password for your {{appName}} account.",
    codeLabel: "Your verification code is",
    expiryNote: "This code expires in {{minutes}} minutes. Enter it on the reset page to choose a new password.",
    securityNote: "Keep this code private. Never share it with anyone, including shop staff. We will never ask you for it by phone or message.\n\nIf you did not request a password reset, you can safely ignore this email. Your password will not change.",
  },
  login: {
    label: "Sign-in code",
    help: "Sent at sign-in to staff whose account asks for a code every time. The code is shown in its own box.",
    subject: "Your MediPos sign-in verification code",
    eyebrow: "Security",
    heading: "Confirm it is you",
    body: "Hello {{name}},\n\nYour verification code is:\n\n{{password}}\n\nUse it to finish signing in to {{appName}}. The code expires in {{minutes}} minutes. If this was not you, do not share the code and tell an administrator.",
  },
  welcome: {
    label: "New staff account",
    help: "Sent when an administrator creates a staff login. Include {{email}} and {{password}}.",
    subject: "Welcome to {{appName}}: your account is ready",
    eyebrow: "Welcome",
    heading: "Your account is ready",
    body: "Hello {{name}},\n\nYour {{appName}} account for {{shopName}} is ready.\n\nEmail: {{email}}\nTemporary password: {{password}}\n\nYou must change this password the first time you sign in.",
    button: "Sign in to {{appName}}",
  },
  reset: {
    label: "Password reset by administrator",
    help: "Sent when an administrator resets someone's password. Include {{email}} and {{password}}.",
    subject: "Your {{appName}} password was reset",
    eyebrow: "Account update",
    heading: "Your password was reset",
    body: "Hello {{name}},\n\nAn administrator reset your password.\n\nEmail: {{email}}\nTemporary password: {{password}}\n\nYou must change this password when you sign in.",
    button: "Sign in to {{appName}}",
  },
};
