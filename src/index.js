/*!
 * Copyright 2025 Allons-Y. All rights reserved.
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at <http://www.apache.org/licenses/LICENSE-2.0>
 */

import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { run } from "./run.js";

// Entry: errors propagate to setFailed at the top level only.
run({ core, context, getOctokit }).catch((error) => {
	core.error(error.stack ?? String(error));
	core.setFailed(error.message);
});
