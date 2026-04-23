-- Fix for:
-- new row for relation "project_rates" violates check constraint
-- "project_rates_creative_type_check"
--
-- Run this once in Supabase SQL Editor.

ALTER TABLE project_rates
  DROP CONSTRAINT IF EXISTS project_rates_creative_type_check;

ALTER TABLE project_rates
  ADD CONSTRAINT project_rates_creative_type_check
  CHECK (creative_type IN ('video', 'design'));

ALTER TABLE project_rates
  DROP CONSTRAINT IF EXISTS project_rates_rank_check;

ALTER TABLE project_rates
  ADD CONSTRAINT project_rates_rank_check
  CHECK (rank IN ('A', 'B', 'C'));

ALTER TABLE project_rate_extras
  DROP CONSTRAINT IF EXISTS project_rate_extras_creative_type_check;

ALTER TABLE project_rate_extras
  ADD CONSTRAINT project_rate_extras_creative_type_check
  CHECK (creative_type IN ('video', 'design'));
