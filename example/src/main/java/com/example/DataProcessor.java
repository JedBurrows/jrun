package com.example;

/**
 * Processes a batch of items and exits.
 *
 * Usage:
 *   jrun start com.example.DataProcessor
 *   jrun start com.example.DataProcessor -- --count 5 --label "order"
 *
 * Flags:
 *   --count N    number of items to process (default: 3)
 *   --label TEXT label for each item (default: "item")
 */
public class DataProcessor {
    public static void main(String[] args) {
        int count = 3;
        String label = "item";

        for (int i = 0; i < args.length; i++) {
            if ("--count".equals(args[i]) && i + 1 < args.length) {
                count = Integer.parseInt(args[++i]);
            } else if ("--label".equals(args[i]) && i + 1 < args.length) {
                label = args[++i];
            }
        }

        System.out.println("Processing " + count + " " + label + "(s)...");
        for (int i = 1; i <= count; i++) {
            System.out.println("  [" + i + "/" + count + "] processed " + label + "-" + i);
        }
        System.out.println("Done.");
    }
}
