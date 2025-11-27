#!/usr/bin/env node
import { Command } from 'commander';
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import open from 'open';
import Conf from 'conf';
import dotenv from 'dotenv';
import process from 'process';
import { intro, outro, confirm, isCancel, cancel, text } from '@clack/prompts';
import chalk from 'chalk';
import yoctoSpinner from 'yocto-spinner';
import { CoreViz } from '@coreviz/sdk';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

dotenv.config({ quiet: true });

const config = new Conf({ projectName: 'coreviz-cli' });
const program = new Command();

const authClient = createAuthClient({
    baseURL: "https://lab.coreviz.io",
    plugins: [
        deviceAuthorizationClient()
    ]
});

program
    .name('coreviz')
    .description('CoreViz CLI')
    .version('1.0.1');

program.command('login')
    .description('Login to CoreViz using device authorization')
    .action(async () => {
        intro(chalk.bgHex('#663399').white('CoreViz'));

        const session = config.get('session');
        if (session) {
            const shouldReauth = await confirm({
                message: "You're already logged in. Do you want to log in again?",
                initialValue: false,
            });

            if (isCancel(shouldReauth) || !shouldReauth) {
                cancel("Login cancelled.");
                process.exit(0);
            }
        }

        const spinner = yoctoSpinner({ text: "Requesting device authorization..." });
        spinner.start();

        try {
            const { data, error } = await authClient.device.code({
                client_id: "coreviz-cli",
                scope: "openid profile email",
            });

            spinner.stop();

            if (error) {
                cancel(`Failed to request device authorization: ${error.message || error}`);
                process.exit(1);
            }

            if (!data) {
                cancel('No data received from server.');
                process.exit(1);
            }

            const { verification_uri, user_code, device_code, interval = 5, expires_in } = data;

            console.log("");
            console.log(chalk.cyan("📱 Device Authorization Required"));
            console.log("");
            console.log(`Please visit: ${chalk.underline.blue(verification_uri)}`);
            console.log(`Enter code: ${chalk.bold.green(user_code)}`);
            console.log("");

            try {
                await open(verification_uri);
            } catch (err) {
                console.log(chalk.yellow("Could not open browser automatically."));
            }

            console.log(chalk.gray(`Waiting for authorization (expires in ${Math.floor(expires_in / 60)} minutes)...`));

            const tokenData = await pollForToken(device_code, interval);

            if (tokenData) {
                config.set('session', tokenData);

                // Fetch user info to display name
                const { data: sessionData } = await authClient.getSession({
                    fetchOptions: {
                        headers: {
                            Authorization: `Bearer ${tokenData.access_token}`,
                        },
                    },
                });

                outro(chalk.green(`✅ Login successful! Logged in as ${sessionData?.user?.name || sessionData?.user?.email || 'User'}`));
            }

        } catch (e) {
            spinner.stop();
            cancel(`An unexpected error occurred: ${e.message}`);
            process.exit(1);
        }
    });

async function pollForToken(deviceCode, initialInterval) {
    let pollingInterval = initialInterval;
    const spinner = yoctoSpinner({ text: "Polling for authorization..." });
    spinner.start();

    return new Promise((resolve, reject) => {
        const poll = async () => {
            try {
                const { data, error } = await authClient.device.token({
                    client_id: "coreviz-cli",
                    device_code: deviceCode,
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code"
                });

                if (data) {
                    spinner.stop();
                    resolve(data);
                    return;
                } else if (error) {
                    switch (error.error) {
                        case "authorization_pending":
                            // Continue polling
                            break;
                        case "slow_down":
                            pollingInterval += 5;
                            spinner.text = chalk.yellow(`Slowing down polling to ${pollingInterval}s...`);
                            break;
                        case "access_denied":
                            spinner.stop();
                            cancel("Access was denied by the user.");
                            process.exit(1);
                            break;
                        case "expired_token":
                            spinner.stop();
                            cancel("The device code has expired. Please try again.");
                            process.exit(1);
                            break;
                        default:
                            // Ignore unknown errors and keep polling? Or fail?
                            // Better-auth might return other errors.
                            if (!['authorization_pending', 'slow_down'].includes(error.error)) {
                                spinner.stop();
                                cancel(`Error: ${error.error_description || error.message}`);
                                process.exit(1);
                            }
                            break;
                    }
                }
            } catch (err) {
                spinner.stop();
                cancel(`Network error: ${err.message}`);
                process.exit(1);
            }

            setTimeout(poll, pollingInterval * 1000);
        };

        setTimeout(poll, pollingInterval * 1000);
    });
}

program.command('logout')
    .description('Logout')
    .action(() => {
        intro(chalk.bgHex('#663399').white('CoreViz'));
        config.clear();
        outro(chalk.green('Logged out successfully.'));
    });

program.command('whoami')
    .description('Show current user')
    .action(() => {
        intro(chalk.bgHex('#663399').white('CoreViz'));
        const session = config.get('session');
        if (session && (session.user || session.access_token)) {
            const userDisplay = session.user
                ? `${session.user.name} (${session.user.email})`
                : 'Authenticated User (Token only)';
            outro(chalk.green(`Logged in as: ${userDisplay}`));
        } else {
            outro(chalk.yellow('Not logged in.'));
        }
    });

program.command('edit <image-path> <prompt>')
    .description('Edit an image using AI')
    .option('--quiet', 'Suppress UI output (for scripting)')
    .action(async (imagePath, prompt, options) => {
        if (!options.quiet) {
            intro(chalk.bgHex('#663399').white('CoreViz'));
        }

        const session = config.get('session');
        if (!session || !session.access_token) {
            if (options.quiet) {
                console.error('Not logged in.');
                process.exit(1);
            }
            cancel('You are not logged in. Please run `coreviz login` first.');
            process.exit(1);
        }

        if (!fs.existsSync(imagePath)) {
            if (options.quiet) {
                console.error(`File not found: ${imagePath}`);
                process.exit(1);
            }
            cancel(`File not found: ${imagePath}`);
            process.exit(1);
        }

        if (!prompt) {
            if (options.quiet) {
                console.error('Prompt is required in quiet mode.');
                process.exit(1);
            }
            prompt = await text({
                message: 'What would you like to change in the image?',
                placeholder: 'e.g., "Make it look like a painting" or "Add a red hat"',
                validate(value) {
                    if (value.length === 0) return `Value is required!`;
                },
            });

            if (isCancel(prompt)) {
                cancel('Operation cancelled.');
                process.exit(0);
            }
        }

        let spinner;
        if (!options.quiet) {
            spinner = yoctoSpinner({ text: "Processing image..." });
            spinner.start();
        }

        try {
            const base64Image = readImageAsBase64(imagePath);

            const coreviz = new CoreViz({ token: session.access_token });
            const resultBase64 = await coreviz.edit(base64Image, {
                prompt
            });

            if (spinner) spinner.stop();

            // Save result
            const outputFilename = `edited-${Date.now()}-${path.basename(imagePath)}`;
            const outputBuffer = Buffer.from(resultBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
            fs.writeFileSync(outputFilename, outputBuffer);

            if (options.quiet) {
                console.log(outputFilename);
            } else {
                outro(chalk.green(`✅ Image edited successfully! Saved as ${outputFilename}`));
            }

        } catch (error) {
            if (spinner) spinner.stop();
            const msg = error.message.includes('credits')
                ? 'Insufficient credits. Please add credits to your account on https://lab.coreviz.io.'
                : `Failed to edit image: ${error.message}`;
            if (options.quiet) {
                console.error(msg);
            } else {
                cancel(msg);
            }
            process.exit(1);
        }
    });

program.command('describe <image-path>')
    .description('Describe an image using AI')
    .option('--quiet', 'Suppress UI output (for scripting)')
    .action(async (imagePath, options) => {
        if (!options.quiet) {
            intro(chalk.bgHex('#663399').white('CoreViz'));
        }

        const session = config.get('session');
        if (!session || !session.access_token) {
            if (options.quiet) {
                console.error('Not logged in.');
                process.exit(1);
            }
            cancel('You are not logged in. Please run `coreviz login` first.');
            process.exit(1);
        }

        if (!fs.existsSync(imagePath)) {
            if (options.quiet) {
                console.error(`File not found: ${imagePath}`);
                process.exit(1);
            }
            cancel(`File not found: ${imagePath}`);
            process.exit(1);
        }

        let spinner;
        if (!options.quiet) {
            spinner = yoctoSpinner({ text: "Analyzing image..." });
            spinner.start();
        }

        try {
            const base64Image = readImageAsBase64(imagePath);
            const coreviz = new CoreViz({ token: session.access_token });
            const description = await coreviz.describe(base64Image);

            if (spinner) spinner.stop();

            if (options.quiet) {
                console.log(description);
            } else {
                outro(chalk.green('✅ Image description:'));
                console.log(description);
            }
        } catch (error) {
            if (spinner) spinner.stop();
            const msg = error.message.includes('credits')
                ? 'Insufficient credits. Please add credits to your account on https://lab.coreviz.io.'
                : `Failed to describe image: ${error.message}`;

            if (options.quiet) {
                console.error(msg);
            } else {
                cancel(msg);
            }
            process.exit(1);
        }
    });

program.command('tag <image-path> <prompt>')
    .description('Generate tags for an image using AI')
    .option('--choices <items>', 'Comma-separated list of possible tags to choose from (optional)', '')
    .option('--single', 'Return only one tag', false)
    .option('-m, --mode <mode>', 'The mode to use for tagging. Defaults to "api".', 'api')
    .option('--quiet', 'Output raw text for scripting (suppresses UI)')
    .action(async (imagePath, prompt, options) => {
        if (!options.quiet) {
            intro(chalk.bgHex('#663399').white('CoreViz'));
        }

        const session = config.get('session');
        if (!session || !session.access_token) {
            if (options.quiet) {
                console.error('Not logged in.');
                process.exit(1);
            }
            cancel('You are not logged in. Please run `coreviz login` first.');
            process.exit(1);
        }

        if (!fs.existsSync(imagePath)) {
            if (options.quiet) {
                console.error(`File not found: ${imagePath}`);
                process.exit(1);
            }
            cancel(`File not found: ${imagePath}`);
            process.exit(1);
        }

        let tagList = options.choices ? options.choices.split(',').map(s => s.trim()) : undefined;

        if (!prompt) {
            if (tagList && tagList.length > 0) {
                prompt = "Select the best matching tags";
            } else {
                if (options.quiet) {
                    console.error('Prompt is required in quiet mode.');
                    process.exit(1);
                }
                prompt = await text({
                    message: 'What kind of tags do you want to generate?',
                    placeholder: 'e.g., "jersey number of the player", "color of the car", etc.',
                    validate(value) {
                        if (value.length === 0) return `Value is required!`;
                    },
                });

                if (isCancel(prompt)) {
                    cancel('Operation cancelled.');
                    process.exit(0);
                }
            }
        }

        let spinner;
        if (!options.quiet) {
            setTimeout(() => {
                if (spinner.isSpinning && options.mode === 'local') {
                    spinner.text = "On the first run, it might take a few minutes to load the local model, please wait...";
                } else if (spinner.isSpinning && options.mode === 'api') {
                    spinner.text = "This might take a few seconds...";
                }
            }, 8000);
            spinner = yoctoSpinner({ text: "Generating tags..." });
            spinner.start();
        }

        try {
            const base64Image = readImageAsBase64(imagePath);
            const coreviz = new CoreViz({ token: session.access_token });

            const response = await coreviz.tag(base64Image, {
                mode: options.mode,
                prompt,
                options: tagList,
                multiple: !options.single
            });

            if (spinner) spinner.stop();

            if (options.quiet) {
                if (response.tags && response.tags.length > 0) {
                    console.log(response.tags.join('\n'));
                }
            } else {
                if (response.tags && response.tags.length > 0) {
                    outro(chalk.green('✅ Tags generated:'));
                    response.tags.forEach(tag => console.log(chalk.blue(`• ${tag}`)));
                } else {
                    outro(chalk.yellow('No tags generated.'));
                }
            }

        } catch (error) {
            if (spinner) spinner.stop();
            const msg = error.message.includes('credits')
                ? 'Insufficient credits. Please add credits to your account on https://lab.coreviz.io.'
                : `Failed to generate tags: ${error.message}`;

            if (options.quiet) {
                console.error(msg);
            } else {
                cancel(msg);
            }
            process.exit(1);
        }
    });

program.command('search <query>')
    .description('Search for images in the current directory using AI')
    .option('-m, --mode <mode>', 'The mode to use for embedding. Defaults to "local".', 'local')
    .option('--quiet', 'Suppress UI output (for scripting)')
    .action(async (query, options) => {
        if (!options.quiet) {
            intro(chalk.bgHex('#663399').white('CoreViz'));
        }

        const mode = options.mode || 'local';

        const session = config.get('session');
        if (!session || !session.access_token) {
            if (options.quiet) {
                console.error('Not logged in.');
                process.exit(1);
            }
            cancel('You are not logged in. Please run `coreviz login` first.');
            process.exit(1);
        }

        let spinner;
        if (!options.quiet) {
            spinner = yoctoSpinner({ text: "Indexing directory..." });
            spinner.start();
        }

        const dbPath = path.join(process.cwd(), '.index.db');
        const db = new Database(dbPath);

        // Initialize DB
        db.prepare(`
            CREATE TABLE IF NOT EXISTS images (
                path TEXT PRIMARY KEY,
                mtime REAL,
                embedding TEXT
            )
        `).run();

        const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff'];
        const files = fs.readdirSync(process.cwd())
            .filter(file => imageExtensions.includes(path.extname(file).toLowerCase()));

        if (files.length === 0) {
            if (spinner) spinner.stop();
            if (options.quiet) {
                // No images found, just exit with 0 (empty result) or 1? 
                // Usually empty search is exit 0 with empty stdout.
                process.exit(0);
            }
            cancel('No images found in the current directory.');
            process.exit(0);
        }

        const coreviz = new CoreViz({ token: session.access_token });

        // Prepare statements
        const getFile = db.prepare('SELECT mtime FROM images WHERE path = ?');
        const upsertFile = db.prepare('INSERT OR REPLACE INTO images (path, mtime, embedding) VALUES (?, ?, ?)');
        const deleteFile = db.prepare('DELETE FROM images WHERE path = ?');

        // Clean up deleted files from index
        const allIndexedFiles = db.prepare('SELECT path FROM images').all();
        for (const row of allIndexedFiles) {
            if (!files.includes(row.path)) {
                deleteFile.run(row.path);
            }
        }

        if (mode === 'local') {
            // You're using the local model, it might take a few minutes for the model to load on the first run.
            setTimeout(() => {
                if (spinner.isSpinning && mode === 'local') {
                    spinner.text = "On the first run, it might take a few minutes to load the local model, please wait...";
                }
            }, 8000);
            await coreviz.embed('text', { type: 'text', mode: mode });
            if (spinner) spinner.stop();
        }

        for (const file of files) {
            const filePath = path.join(process.cwd(), file);
            const stats = fs.statSync(filePath);
            const mtime = stats.mtimeMs;

            const existing = getFile.get(file);

            // Skip if already indexed and not modified
            if (existing && existing.mtime === mtime) {
                continue;
            }

            if (spinner) spinner.text = `Indexing ${file}...`;

            try {
                const base64Image = readImageAsBase64(filePath);
                const { embedding } = await coreviz.embed(base64Image, { type: 'image', mode: mode });

                upsertFile.run(file, mtime, JSON.stringify(embedding));
            } catch (error) {
                // Log error but continue
                if (!options.quiet) {
                    if (error.message.includes('credits')) {
                        cancel('Insufficient credits. Please add credits to your account on https://lab.coreviz.io.');
                        process.exit(1);
                    }
                    console.error(`Failed to index ${file}: ${error.message}`);
                }
            }
        }

        if (spinner) spinner.text = "Processing search query...";

        try {
            const { embedding: queryEmbedding } = await coreviz.embed(query, { type: 'text', mode: mode });

            const rows = db.prepare('SELECT path, embedding FROM images').all();
            const results = [];

            for (const row of rows) {
                if (!row.embedding) continue;

                const fileEmbedding = JSON.parse(row.embedding);

                // Calculate cosine similarity
                const similarity = coreviz.similarity(queryEmbedding, fileEmbedding);
                results.push({ file: row.path, similarity });
            }

            // Sort by similarity descending
            results.sort((a, b) => b.similarity - a.similarity);

            if (spinner) spinner.stop();

            if (options.quiet) {
                // Output raw file paths (top 5)
                results.slice(0, 5).forEach(result => {
                    console.log(result.file);
                });
            } else {
                outro(chalk.green(`✅ Search results for "${query}"`));

                // Show top 5 results
                results.slice(0, 5).forEach((result, i) => {
                    const score = (result.similarity * 100).toFixed(1);
                    console.log(`${i + 1}. ${chalk.bold(result.file)} ${chalk.gray(`(${score}%)`)}`);
                });
            }

        } catch (error) {
            if (spinner) spinner.stop();
            const msg = `Search failed: ${error.message}`;
            if (options.quiet) {
                console.error(msg);
            } else {
                cancel(msg);
            }
            process.exit(1);
        } finally {
            db.close();
        }
    });

function readImageAsBase64(imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    return `data:image/${path.extname(imagePath).slice(1) || 'jpeg'};base64,${imageBuffer.toString('base64')}`;
}

program.parse(process.argv);
