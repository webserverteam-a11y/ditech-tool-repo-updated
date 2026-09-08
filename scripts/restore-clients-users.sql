-- Restore clients and users wiped by the config-default overwrite bug.
--
-- CAUSE: when /api/config/users or /api/config/admin_options returned a
-- non-2xx (e.g. the brief 502/503 window during a redeploy), the browser
-- swallowed it as null and posted its built-in DEMO lists back to the server.
-- Those endpoints treat the payload as the complete list and delete anything
-- absent from it, so every client and user added through the tool was removed
-- and the default accounts' passwords were reset to demo values.
--
-- FIXED BY: scripts/patch-config-default-wipe-fix.js (client no longer posts
-- defaults on a failed load) and the mass-deletion guards added to
-- backend/routes/config.routes.js (server refuses to delete many at once).
--
-- SOURCE: u877454648_ditech_tool (2).sql, snapshot taken 2026-09-07.
--
-- SAFE TO RE-RUN: INSERT IGNORE never overwrites an existing row, so anything
-- already restored or re-added by hand is left exactly as it is. Nothing is
-- deleted. Passwords are restored still-encrypted, as originally stored.
--
-- Take a database backup before running, as with any restore.

START TRANSACTION;

INSERT IGNORE INTO `clients` (`id`,`name`,`sort_order`,`created_at`,`updated_at`) VALUES
(1, 'Aashish Metals', 0, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(2, 'Amardeep', 1, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(3, 'DSE', 2, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(4, 'JadeAlloys', 3, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(5, 'KPS', 4, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(6, 'KPSol', 5, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(7, 'Metinoxoverseas', 6, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(8, 'Milife', 7, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(9, 'Navyug', 8, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(10, 'Petverse', 9, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(11, 'SPAT', 10, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(12, 'Solitaire', 11, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(13, 'USA piping', 12, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(14, 'Unifit', 13, '2026-04-08 18:43:06', '2026-04-08 18:43:06'),
(2281549, 'A5E Consulting', 14, '2026-08-02 17:39:51', '2026-08-02 17:39:51'),
(2281550, 'All Clients', 15, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281551, 'Cliniderm', 16, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281552, 'Dentech', 17, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281553, 'Develearn', 18, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281554, 'DiTech Inhouse', 19, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281555, 'DPA', 20, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281556, 'Edunation', 21, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281557, 'FINNED TUBES', 22, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281558, 'GSE Renewables', 23, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281559, 'Kumarfilter', 24, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281560, 'Lakshya', 25, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281561, 'Manimo', 26, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281562, 'MRP', 27, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281563, 'Rockwool', 28, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281564, 'Techzert', 29, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281565, 'Thomas Cook', 30, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281566, 'Valeurfabtex', 31, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281567, 'Yogi Impressions', 32, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2281568, 'Zuma', 33, '2026-08-02 17:39:51', '2026-08-02 17:40:08'),
(2363792, 'Sachin Steel', 34, '2026-08-06 04:10:20', '2026-08-06 04:10:20'),
(2546458, 'DPH Engg', 35, '2026-08-12 10:59:32', '2026-08-12 10:59:32');

INSERT IGNORE INTO `users` (`id`,`name`,`password`,`role`,`ownerName`,`created_at`,`updated_at`,`email`) VALUES
('admin', 'Admin', 'enc:5c6de5687777655777300611:6818af8fb6c80121377be8578fa9f5bf:54bb415ff3687e78', 'admin', '', '2026-03-27 08:39:07', '2026-09-07 17:19:11', NULL),
('gauri', 'Gauri', 'enc:1439653235182835c2d490db:ca66aa5571fcf501195e96115d57d732:a3e0ffd796aff01e', 'web', 'Gauri', '2026-04-10 23:56:46', '2026-09-07 17:19:11', NULL),
('heena', 'Heena', 'enc:62d3ae0475943fd952b5e7d7:4e35793c9d110aeb0dc4654fc05fc98c:a40cf83bc7589f8c', 'content', 'Heena', '2026-04-10 23:56:46', '2026-09-07 17:19:11', NULL),
('hemang', 'Hemang', 'enc:c7e80245afff9869e62f7d1a:9ccf72848ec63597b0de074f97ec1076:0363e82faa287a6458', 'seo', 'Hemang', '2026-04-10 23:56:46', '2026-09-07 17:19:11', NULL),
('imran', 'Imran', 'enc:aa3d3ac1b959ee3c7be5cba4:6488fdd411fec20de9ea13fdd9cf060c:bb2d9ae1e42ea271', 'seo', 'Imran', '2026-04-10 23:56:46', '2026-09-07 17:19:11', NULL),
('kamna', 'Kamna', 'enc:8d335bf59426d7849d4d221a:67c63c9ae26b3b850238fb1594c32a15:4c4df386ce6fe742', 'seo', 'Kamna', '2026-04-10 23:56:46', '2026-09-07 17:19:11', NULL),
('manish', 'Manish', 'enc:ffeec5c75f4ee1660b002683:7cacbfcf7a7b4bfd42ec2947bb6e3756:627830508fe1ca3835', 'seo', 'Manish', '2026-04-10 23:56:46', '2026-09-07 17:19:11', NULL),
('shubham', 'Shubham', 'enc:3d3dbd91fecd347c5ce32eaa:57f468cbdd502b5e5d23eec5a4c43e64:e9337f1ea73defc481c2', 'web', 'Shubham', '2026-04-10 23:56:46', '2026-09-07 17:19:11', NULL),
('user-1776060000708', 'Pathak', 'enc:e2f0b48f9ddac49233d7706b:2fb06b42833f45743b1075bd68e6e248:0decb3e18d8ade3ca9', 'content', 'Pathak', '2026-09-06 14:36:38', '2026-09-07 17:19:11', NULL),
('user-1776061003266', 'Patel', 'enc:59b08bdcaf69b881180657d8:3d697c1c1caa9cd0c19e79792bed1052:bff1421c8926e325', 'ads', 'Patel', '2026-09-06 14:36:38', '2026-09-07 17:19:11', NULL),
('user-1776062077960', 'Hemang_P', 'enc:17eb23be5881c282cd0c79ce:fcddeced98093afd67fffdf840b57562:fc3e57baeabac41a', 'admin', '', '2026-09-06 14:36:38', '2026-09-07 17:19:11', NULL),
('user-1776062283928', 'Sunil', 'enc:107cbdf6b4212c496325d221:001e69c59f6a929f172e962cdd11ac47:7b6c774d7c9be9c9', 'design', 'Sunil', '2026-09-06 14:36:38', '2026-09-07 17:19:11', NULL),
('user-1776664743085', 'Interns', 'enc:8f12d224185edcc72ed161f7:57b01165049f15075dbe773b49470de8:06ab956124f4d0c0b21d', 'seo', 'Interns', '2026-09-06 14:36:38', '2026-09-07 17:19:11', NULL),
('user-1786595106723', 'Trisha', 'enc:605f8aa02db08c0cdaf964ad:a6b615c18b46ee8696599495ba713b7a:2bddf25027b634ea76', 'content', 'Trisha', '2026-09-06 14:36:38', '2026-09-07 17:19:11', NULL);

COMMIT;

-- Verify afterwards:
--   SELECT COUNT(*) FROM clients;  -- expect 36
--   SELECT COUNT(*) FROM users;    -- expect 14
--   SELECT name, role FROM users ORDER BY created_at;
