import nodemailer from "nodemailer";
import { config } from "../config.ts";
import { openSecret } from "./secrets.ts";

export function smtpConfigured() {
  return Boolean(config.smtp.enabled && config.smtp.host && config.smtp.fromEmail);
}

function transport() {
  if (!smtpConfigured()) {
    throw new Error("SMTP is not configured. Enable it in Settings > Mail.");
  }
  const password = openSecret(config.smtp.passwordSealed);
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.username
      ? { user: config.smtp.username, pass: password ?? "" }
      : undefined,
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 20_000,
  });
}

export async function sendMail(input: {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}) {
  const to = Array.isArray(input.to) ? input.to : [input.to];
  const recipients = to.map((value) => value.trim()).filter((value) => value.includes("@"));
  if (recipients.length === 0) throw new Error("No valid email recipient.");
  await transport().sendMail({
    from: {
      name: config.smtp.fromName || "Cetus",
      address: config.smtp.fromEmail,
    },
    to: recipients,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
