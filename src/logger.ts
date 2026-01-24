import pino from 'pino';

// Detect if we're in production
const isProduction = process.env.NODE_ENV === 'production';

// Configure Pino
// In production, we output raw JSON (standard for Docker/Cloud logs)
// In development, we use pino-pretty for readability
const pinoLogger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: {
        env: process.env.NODE_ENV || 'development',
        service: 'alertscrapper-bot'
    },
    transport: isProduction ? undefined : {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
        },
    },
});

class AppLogger {
    info(message: string, channelId?: number, context?: any) {
        pinoLogger.info({ channelId, ...context }, message);
    }

    error(message: string, channelId?: number, context?: any) {
        pinoLogger.error({ channelId, ...context }, message);
    }

    warn(message: string, channelId?: number, context?: any) {
        pinoLogger.warn({ channelId, ...context }, message);
    }

    debug(message: string, channelId?: number, context?: any) {
        pinoLogger.debug({ channelId, ...context }, message);
    }
}

export const logger = new AppLogger();
