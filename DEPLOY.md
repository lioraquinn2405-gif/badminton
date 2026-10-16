# Đưa web lên Vercel + Supabase

## 1. Supabase (cơ sở dữ liệu)
1. Vào https://supabase.com → Sign in → **New project** (đặt tên, đặt mật khẩu DB, chọn vùng Singapore).
2. Chờ tạo xong → menu trái **SQL Editor** → **New query** → dán toàn bộ file `supabase/schema.sql` → **Run**.
3. Menu **Project Settings → API**, copy 2 giá trị:
   - **Project URL** (dạng `https://xxxx.supabase.co`)
   - **service_role key** (mục "Project API keys" — KHÔNG đưa key này cho ai, không dán vào code).

## 2. Vercel (web)
1. Đưa thư mục này lên GitHub (repo mới).
2. https://vercel.com → **Add New → Project** → chọn repo.
3. Mục **Environment Variables** thêm:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = service_role key
4. **Deploy**. Vercel cấp link dạng `https://ten-du-an.vercel.app`.

## 3. Sau khi có link
- Mở link, **tạo tài khoản đầu tiên** → tự thành quản trị viên.
- (Tuỳ chọn) chuyển dữ liệu đăng ký đang có ở `data.json`:
  `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run import`
