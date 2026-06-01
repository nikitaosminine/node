-- Fix handle_new_user: profiles table uses `id` (not `user_id`) as the primary key column.
-- Migration 000000 incorrectly recreated the function with `user_id`, breaking signup.
-- Also populate the `email` column which the old version omitted.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), NEW.email);
  RETURN NEW;
END;
$$;
