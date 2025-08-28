import { RimoriClient } from './RimoriClient';
import html2canvas from 'html2canvas';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
  context?: {
    url: string;
    userAgent: string;
    browserInfo: BrowserInfo;
    screenshot?: string;
    mousePosition?: MousePosition;
  };
}

interface BrowserInfo {
  userAgent: string;
  language: string;
  cookieEnabled: boolean;
  onLine: boolean;
  screenResolution: string;
  windowSize: string;
  timestamp: string;
}

interface MousePosition {
  x: number;
  y: number;
  timestamp: string;
}

/**
 * Singleton Logger class for Rimori client plugins.
 * Handles all logging levels, production filtering, and log transmission to Rimori.
 * Overrides console methods globally for seamless integration.
 */
export class Logger {
  private static instance: Logger;
  private isProduction: boolean;
  private logs: LogEntry[] = [];
  private logIdCounter = 0;
  private originalConsole: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
  };
  private mousePosition: MousePosition | null = null;

  private constructor(rimori: RimoriClient, isProduction?: boolean) {
    this.isProduction = this.validateIsProduction(isProduction);

    // Store original console methods
    this.originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    };

    // Override console methods globally
    this.overrideConsoleMethods();

    // Track mouse position
    this.trackMousePosition();

    // Expose logs to global scope for DevTools access
    this.exposeToDevTools();

    // Set up navigation clearing
    this.setupNavigationClearing();

    rimori.event.respond('logging.requestPluginLogs', async () => {
      this.addLogEntry(await this.createLogEntry('info', 'Screenshot capture', undefined, true));
      const logs = {
        logs: this.logs,
        pluginId: rimori.plugin.pluginId,
        timestamp: new Date().toISOString()
      }
      this.logs = [];
      this.logIdCounter = 0;
      return logs;
    });
  }

  /**
   * Initialize the Logger singleton and override console methods globally.
   * @param rimori - Rimori client instance
   * @param isProduction - Whether the environment is production
   * @returns Logger instance
   */
  public static getInstance(rimori: RimoriClient, isProduction?: boolean): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(rimori, isProduction);
    }
    return Logger.instance;
  }

  private validateIsProduction(isProduction?: boolean): boolean {
    if (isProduction !== undefined) {
      return isProduction;
    }
    if (typeof window !== 'undefined' && window.location.href) {
      return !window.location.href.includes('localhost');
    }
    return true;
  }
  /**
   * Expose log access to global scope for DevTools console access.
   */
  private exposeToDevTools(): void {
    if (typeof window !== 'undefined') {
      // Expose a global function to access logs from DevTools console
      (window as any).getRimoriLogs = () => this.logs;
    }
  }

  /**
   * Set up navigation event listeners to clear logs on page changes.
   */
  private setupNavigationClearing(): void {
    if (typeof window === 'undefined' || typeof history === 'undefined') return;

    // Clear logs on browser back/forward
    window.addEventListener('popstate', () => this.logs = []);

    // Override history methods to clear logs on programmatic navigation
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = (...args) => {
      originalPushState.apply(history, args);
      this.logs = [];
    };

    history.replaceState = (...args) => {
      originalReplaceState.apply(history, args);
      this.logs = [];
    };

    // Listen for URL changes (works with React Router and other SPAs)
    let currentUrl = window.location.href;
    const checkUrlChange = () => {
      if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        this.logs = [];
      }
    };

    // Check for URL changes periodically
    setInterval(checkUrlChange, 100);

    // Also listen for hash changes (for hash-based routing)
    window.addEventListener('hashchange', () => this.logs = []);
  }

  /**
   * Override console methods globally to capture all console calls.
   */
  private overrideConsoleMethods(): void {
    // Override console.log
    console.log = (...args: any[]) => {
      this.originalConsole.log(...args);
      this.handleConsoleCall('info', args);
    };

    // Override console.info
    console.info = (...args: any[]) => {
      this.originalConsole.info(...args);
      this.handleConsoleCall('info', args);
    };

    // Override console.warn
    console.warn = (...args: any[]) => {
      this.originalConsole.warn(...args);
      this.handleConsoleCall('warn', args);
    };

    // Override console.error
    console.error = (...args: any[]) => {
      this.originalConsole.error(...args);
      this.handleConsoleCall('error', args);
    };

    // Override console.debug
    console.debug = (...args: any[]) => {
      this.originalConsole.debug(...args);
      this.handleConsoleCall('debug', args);
    };
  }

  /**
   * Track mouse position for screenshot context.
   */
  private trackMousePosition(): void {
    if (typeof window !== 'undefined') {
      const updateMousePosition = (event: MouseEvent) => {
        this.mousePosition = {
          x: event.clientX,
          y: event.clientY,
          timestamp: new Date().toISOString()
        };
      };

      window.addEventListener('mousemove', updateMousePosition);
      window.addEventListener('click', updateMousePosition);
    }
  }

  /**
   * Handle console method calls and create log entries.
   * @param level - Log level
   * @param args - Console arguments
   */
  private async handleConsoleCall(level: LogLevel, args: any[]): Promise<void> {
    // Skip if this is a production log that shouldn't be stored
    if (this.isProduction && (level === 'debug' || level === 'info')) {
      return;
    }

    // Convert console arguments to message and data
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    const data = args.length > 1 ? args.slice(1) : undefined;

    const entry = await this.createLogEntry(level, message, data);
    this.addLogEntry(entry);
  }

  /**
   * Get browser and system information for debugging.
   * @returns Object with browser and system information
   */
  private getBrowserInfo(): BrowserInfo {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      screenResolution: `${screen.width}x${screen.height}`,
      windowSize: `${window.innerWidth}x${window.innerHeight}`,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Capture a screenshot of the current page.
   * @returns Promise resolving to base64 screenshot or null if failed
   */
  private async captureScreenshot(): Promise<string | null> {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const canvas = await html2canvas(document.body);
      const screenshot = canvas.toDataURL('image/png');
      // this.originalConsole.log("screenshot captured", screenshot)
      return screenshot;
    }
    return null;
  }

  /**
   * Create a log entry with context information.
   * @param level - Log level
   * @param message - Log message
   * @param data - Additional data
   * @returns Log entry
   */
  private async createLogEntry(level: LogLevel, message: string, data?: any, forceScreenshot?: boolean): Promise<LogEntry> {
    const context: Partial<LogEntry['context']> = {};

    // Add URL if available
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return {
        id: `log_${++this.logIdCounter}_${Date.now()}`,
        timestamp: new Date().toISOString(),
        level,
        message,
        data,
      }
    }

    context.url = window.location.href;

    // Add browser info (this method now handles worker context internally)
    context.browserInfo = this.getBrowserInfo();
    context.userAgent = context.browserInfo.userAgent;

    // Add screenshot and mouse position if level is error or warn
    if (level === 'error' || level === 'warn' || forceScreenshot) {
      context.screenshot = await this.captureScreenshot() || undefined;
      context.mousePosition = this.mousePosition || undefined;
    }

    return {
      id: `log_${++this.logIdCounter}_${Date.now()}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      context: context as LogEntry['context']
    };
  }

  /**
   * Add a log entry to the internal log array.
   * @param entry - Log entry to add
   */
  private addLogEntry(entry: LogEntry): void {
    this.logs.push(entry);

    // Maintain log size limit (1000 entries)
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-1000);
    }
  }
}
