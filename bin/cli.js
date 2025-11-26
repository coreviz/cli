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

dotenv.config();

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

program.parse(process.argv);
