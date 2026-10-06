/**
 * Usage: npx tsx scripts/hash-password.ts "your-strong-password"
 * Put the output into ADMIN_PASSWORD_HASH in .env.local
 */
import bcrypt from "bcryptjs";

const pw = process.argv[2];
if (!pw) {
  console.error("Usage: npx tsx scripts/hash-password.ts <password>");
  process.exit(1);
}
const hash = bcrypt.hashSync(pw, 12);
console.log(hash);
