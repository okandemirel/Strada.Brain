#!/usr/bin/env node
/**
 * Backup Scheduler Runner for Docker
 * Simple JS wrapper to run backups on schedule
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const SCHEDULE = process.env.BACKUP_SCHEDULE || '0 2 * * *';
const LOG_FILE = process.env.LOG_FILE || '/var/log/backup/scheduler.log';

function log(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    console.log(line.trim());
    
    // Append to log file
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(LOG_FILE, line);
}

function parseSchedule(schedule) {
    // Simple cron parser - returns next run time
    const parts = schedule.split(' ');
    if (parts.length !== 5) {
        throw new Error('Invalid schedule format. Use: minute hour day month dayOfWeek');
    }
    
    const [minute, hour] = parts.map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    
    if (next <= now) {
        next.setDate(next.getDate() + 1);
    }
    
    return next;
}

function runBackup() {
    return new Promise((resolve, reject) => {
        log('Starting backup...');
        
        const startTime = Date.now();
        const backup = spawn('/app/backup.sh', [], {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let output = '';
        
        backup.stdout.on('data', (data) => {
            output += data.toString();
            process.stdout.write(data);
        });
        
        backup.stderr.on('data', (data) => {
            output += data.toString();
            process.stderr.write(data);
        });
        
        backup.on('close', (code) => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            
            if (code === 0) {
                log(`Backup completed successfully in ${duration}s`);
                resolve({ success: true, output });
            } else {
                log(`Backup failed with code ${code} after ${duration}s`);
                reject(new Error(`Backup failed with code ${code}`));
            }
        });
        
        backup.on('error', (err) => {
            log(`Backup process error: ${err.message}`);
            reject(err);
        });
    });
}

async function scheduleLoop() {
    log('Backup scheduler started');
    log(`Backup directory: ${BACKUP_DIR}`);
    log(`Schedule: ${SCHEDULE}`);
    
    // Ensure backup directory exists
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    
    // Run initial backup
    try {
        await runBackup();
    } catch (err) {
        log(`Initial backup failed: ${err.message}`);
    }
    
    // Schedule loop
    while (true) {
        const nextRun = parseSchedule(SCHEDULE);
        const waitMs = nextRun.getTime() - Date.now();
        
        log(`Next backup scheduled for: ${nextRun.toISOString()}`);
        log(`Waiting ${(waitMs / 1000 / 60).toFixed(1)} minutes...`);
        
        await new Promise(resolve => setTimeout(resolve, waitMs));
        
        try {
            await runBackup();
        } catch (err) {
            log(`Scheduled backup failed: ${err.message}`);
        }
    }
}

// Handle signals
process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down...');
    process.exit(0);
});

process.on('SIGINT', () => {
    log('Received SIGINT, shutting down...');
    process.exit(0);
});

// Start
scheduleLoop().catch(err => {
    log(`Scheduler error: ${err.message}`);
    process.exit(1);
});
