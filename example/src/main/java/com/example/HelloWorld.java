package com.example;

/**
 * Simple demo — prints a greeting and exits immediately.
 *
 * Usage:
 *   jrun start com.example.HelloWorld
 *   jrun start com.example.HelloWorld Alice
 */
public class HelloWorld {
    public static void main(String[] args) {
        String name = args.length > 0 ? args[0] : "World";
        System.out.println("Hello, " + name + "!");
    }
}
