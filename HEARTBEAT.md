# Strada Brain Daemon Triggers

### health-check
- type: cron
- cron: */5 * * * *
- action: Run periodic health check on the project
- cooldown: 300
