-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1:3306
-- Generation Time: Mar 27, 2026 at 06:56 AM
-- Server version: 11.8.6-MariaDB-log
-- PHP Version: 7.2.34

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `u877454648_ditech_tool`
--

-- --------------------------------------------------------

--
-- Table structure for table `app_config`
--

CREATE TABLE `app_config` (
  `key` varchar(255) NOT NULL,
  `value` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`value`)),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `audit_logs`
--

CREATE TABLE `audit_logs` (
  `id` varchar(100) NOT NULL,
  `month` varchar(7) NOT NULL,
  `timestamp` varchar(50) DEFAULT NULL,
  `user_name` varchar(255) DEFAULT NULL,
  `user_role` varchar(100) DEFAULT NULL,
  `action` varchar(255) DEFAULT NULL,
  `task_id` varchar(255) DEFAULT NULL,
  `task_title` varchar(500) DEFAULT NULL,
  `client` varchar(255) DEFAULT NULL,
  `source` varchar(255) DEFAULT NULL,
  `field` varchar(255) DEFAULT NULL,
  `old_value` text DEFAULT NULL,
  `new_value` text DEFAULT NULL,
  `note` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tasks`
--

CREATE TABLE `tasks` (
  `id` varchar(255) NOT NULL,
  `title` varchar(500) DEFAULT '',
  `client` varchar(255) DEFAULT '',
  `seo_owner` varchar(255) DEFAULT '',
  `seo_stage` varchar(255) DEFAULT '',
  `seo_qc_status` varchar(100) DEFAULT '',
  `focused_kw` varchar(500) DEFAULT '',
  `volume` int(11) DEFAULT 0,
  `mar_rank` int(11) DEFAULT 0,
  `current_rank` int(11) DEFAULT 0,
  `est_hours` decimal(10,2) DEFAULT 0.00,
  `est_hours_seo` decimal(10,2) DEFAULT 0.00,
  `est_hours_content` decimal(10,2) DEFAULT 0.00,
  `est_hours_web` decimal(10,2) DEFAULT 0.00,
  `est_hours_content_rework` decimal(10,2) DEFAULT 0.00,
  `est_hours_seo_review` decimal(10,2) DEFAULT 0.00,
  `actual_hours` decimal(10,2) DEFAULT 0.00,
  `content_assigned_date` varchar(50) DEFAULT '',
  `content_owner` varchar(255) DEFAULT '',
  `content_status` varchar(100) DEFAULT '',
  `web_assigned_date` varchar(50) DEFAULT '',
  `web_owner` varchar(255) DEFAULT '',
  `target_url` text DEFAULT NULL,
  `web_status` varchar(100) DEFAULT '',
  `current_owner` varchar(255) DEFAULT '',
  `days_in_stage` int(11) DEFAULT 0,
  `remarks` text DEFAULT NULL,
  `is_completed` tinyint(1) DEFAULT 0,
  `execution_state` varchar(100) DEFAULT 'Not Started',
  `doc_url` text DEFAULT NULL,
  `intake_date` varchar(50) DEFAULT '',
  `dept_type` varchar(100) DEFAULT '',
  `task_type` varchar(100) DEFAULT '',
  `platform` varchar(100) DEFAULT '',
  `deliverable_url` text DEFAULT NULL,
  `due_date` varchar(50) DEFAULT '',
  `assigned_to` varchar(255) DEFAULT '',
  `ad_budget` decimal(10,2) DEFAULT 0.00,
  `qc_submitted_at` varchar(50) DEFAULT '',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `task_time_events`
--

CREATE TABLE `task_time_events` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `task_id` varchar(255) NOT NULL,
  `event_type` varchar(50) NOT NULL DEFAULT '',
  `timestamp` varchar(50) DEFAULT '',
  `department` varchar(100) DEFAULT '',
  `owner` varchar(255) DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_tte_task` (`task_id`),
  CONSTRAINT `fk_tte_task` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `task_qc_reviews`
--

CREATE TABLE `task_qc_reviews` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `task_id` varchar(255) NOT NULL,
  `review_id` varchar(255) NOT NULL DEFAULT '',
  `submitted_by` varchar(255) DEFAULT '',
  `submitted_by_dept` varchar(100) DEFAULT '',
  `submitted_at` varchar(50) DEFAULT '',
  `assigned_to` varchar(255) DEFAULT '',
  `est_hours` decimal(10,2) DEFAULT 0.00,
  `note` text DEFAULT NULL,
  `outcome` varchar(100) DEFAULT '',
  `completed_at` varchar(50) DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_tqr_task` (`task_id`),
  CONSTRAINT `fk_tqr_task` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `task_rework_entries`
--

CREATE TABLE `task_rework_entries` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `task_id` varchar(255) NOT NULL,
  `rework_id` varchar(255) NOT NULL DEFAULT '',
  `date` varchar(50) DEFAULT '',
  `est_hours` decimal(10,2) DEFAULT 0.00,
  `assigned_dept` varchar(100) DEFAULT '',
  `assigned_owner` varchar(255) DEFAULT '',
  `within_estimate` tinyint(1) DEFAULT 0,
  `hours_already_spent` decimal(10,2) DEFAULT 0.00,
  `start_timestamp` varchar(50) DEFAULT '',
  `end_timestamp` varchar(50) DEFAULT '',
  `duration_ms` bigint(20) DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_tre_task` (`task_id`),
  CONSTRAINT `fk_tre_task` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `role` varchar(50) NOT NULL DEFAULT 'seo',
  `ownerName` varchar(255) DEFAULT '',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `app_config`
--
ALTER TABLE `app_config`
  ADD PRIMARY KEY (`key`);

--
-- Indexes for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_month` (`month`),
  ADD KEY `idx_task_id` (`task_id`);

--
-- Indexes for table `tasks`
--
ALTER TABLE `tasks`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_tasks_client` (`client`),
  ADD KEY `idx_tasks_seo_owner` (`seo_owner`),
  ADD KEY `idx_tasks_intake_date` (`intake_date`),
  ADD KEY `idx_tasks_is_completed` (`is_completed`);

--
-- AUTO_INCREMENT for table `task_time_events`
--
ALTER TABLE `task_time_events`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `task_qc_reviews`
--
ALTER TABLE `task_qc_reviews`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `task_rework_entries`
--
ALTER TABLE `task_rework_entries`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`);
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
