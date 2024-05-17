import express, { Request, Response } from "express";
import { Resonate, Context } from "./lib/async";

async function longRunningFunction(ctx: Context): Promise<string> {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve("Hello World");
        }, 20000);
    });
}

// Initialize a Resonate application.
const resonate = new Resonate();

// Register a function as a Resonate function
resonate.register("longRunningFunction", longRunningFunction, resonate.options({ timeout: 60000 }));

// Start the Resonate application
resonate.start();

// Initialize an Express application.
const app = express().use(express.json());

// Start the process and return its id
app.post("/begin/:fn/:id", async (req: Request, res: Response) => {
    const fn = req.params.fn;
    const id = req.params.id;

    try {
        // Call the resonate function
        let promise = resonate.run(fn, `${fn}-${id}`);
        // Make sure the request is reliably recorded. Important for recovery
        await promise.created;
        res.send(`/begin/${fn}/${id}`);
    } catch (e) {
        res.status(500).send(`An error occurred: ${e}`);
    }
});

// Wait for the process to complete
app.post("/await/:fn/:id", async (req: Request, res: Response) => {
    const fn = req.params.fn;
    const id = req.params.id;

    try {
        // Call the resonate function
        let value = await resonate.run(fn, `${fn}-${id}`);
        res.send(value);
    } catch (e) {
        res.status(500).send(`An error occurred: ${e}`);
    }
});

// Start the Express application
app.listen(3000, () => {
    console.log("Listening on port 3000");
});
