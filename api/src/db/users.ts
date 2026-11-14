import { boolean, pgTable, text } from 'drizzle-orm/pg-core';

export const baneUsers = pgTable('nightmail_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull(),
});
