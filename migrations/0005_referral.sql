-- One referral CTA click per visitor per UTC day. Not a bot event: never written into bot_daily or visit_seen.
CREATE TABLE referral_clicks (day TEXT NOT NULL, vh TEXT NOT NULL, PRIMARY KEY(day, vh));
