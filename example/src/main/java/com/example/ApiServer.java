package com.example;

/**
 * Simulates a long-running server. Runs until killed.
 *
 * Usage:
 *   jrun start com.example.ApiServer
 *   jrun start com.example.ApiServer -- --port 8080
 *
 * Then try:
 *   jrun status
 *   jrun kill com.example.ApiServer
 *
 * Flags:
 *   --port N   port number to display (default: 8080)
 */
public class ApiServer {
    public static void main(String[] args) throws InterruptedException {
        int port = 8080;

        for (int i = 0; i < args.length; i++) {
            if ("--port".equals(args[i]) && i + 1 < args.length) {
                port = Integer.parseInt(args[++i]);
            }
        }

        final int boundPort = port;
        Runtime.getRuntime().addShutdownHook(new Thread(() ->
            System.out.println("\nServer on port " + boundPort + " shutting down.")));

        System.out.println("Server started on port " + port);
        System.out.println("Press Ctrl+C or run 'jrun kill' to stop.");

        int tick = 0;
        while (true) {
            Thread.sleep(5000);
            tick++;
            System.out.println("[" + tick * 5 + "s] Server running on port " + port + "...");
        }
    }
}
