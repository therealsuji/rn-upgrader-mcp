#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "fs";
import { join, dirname, relative, resolve } from "path";
import { createRequire } from "module";

// xcode is a CommonJS module, we need to import it using createRequire
const require = createRequire(import.meta.url);
const xcode = require("xcode");

// SSE / HTTP server removed — this module only supports stdio transport now

const diffCache = new Map<string, string>();

const server = new Server({
  name: "rn-upgrader",
  version: "1.0.0",
  capabilities: {
    tools: {},
  },
});

const tools: Tool[] = [
  {
    name: "get_upgrade_workflow",
    description:
      "Get the complete step-by-step workflow for React Native upgrades. ALWAYS call this first to understand the proper sequence.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_current_rn_version",
    description: "Detect the current React Native version from package.json",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Path to the React Native project",
        },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "get_target_version",
    description: "Get the target React Native version from user input",
    inputSchema: {
      type: "object",
      properties: {
        targetVersion: {
          type: "string",
          description: "Target React Native version to upgrade to",
        },
      },
      required: ["targetVersion"],
    },
  },
  {
    name: "get_upgrade_diff_files",
    description:
      "Get all file names from the full upgrade diff between two RN versions. USAGE: Call this ONCE to get the complete list of files. Then iterate through each file individually using get_file_specific_diff. DO NOT try to process all files at once.",
    inputSchema: {
      type: "object",
      properties: {
        fromVersion: {
          type: "string",
          description: "Current React Native version",
        },
        toVersion: {
          type: "string",
          description: "Target React Native version",
        },
      },
      required: ["fromVersion", "toVersion"],
    },
  },
  {
    name: "get_file_specific_diff",
    description:
      "Get the specific diff for a single file between two RN versions. USAGE: Process files ONE AT A TIME. Call this for each file from get_upgrade_diff_files list, apply the diff, then move to the next file. Do not batch process multiple files.",
    inputSchema: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          description: "Name of the file to get diff for",
        },
        fromVersion: {
          type: "string",
          description: "Current React Native version",
        },
        toVersion: {
          type: "string",
          description: "Target React Native version",
        },
      },
      required: ["fileName", "fromVersion", "toVersion"],
    },
  },
  {
    name: "analyze_file_type",
    description:
      "Analyze a file to determine if it's binary, requires migration, or can be patched normally. Use this before processing each file.",
    inputSchema: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          description: "Name of the file to analyze",
        },
      },
      required: ["fileName"],
    },
  },
  {
    name: "create_upgrade_todo_list",
    description:
      "Generate a structured todo list for React Native upgrade files. Call this after get_upgrade_diff_files to create a trackable task list.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Array of file names from get_upgrade_diff_files",
        },
        fromVersion: {
          type: "string",
          description: "Current React Native version",
        },
        toVersion: {
          type: "string",
          description: "Target React Native version",
        },
      },
      required: ["files", "fromVersion", "toVersion"],
    },
  },
  {
    name: "sync_xcode_project",
    description:
      "Add or remove files from Xcode project. Call this after adding/removing iOS native files.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Path to the React Native project root",
        },
        operation: {
          type: "string",
          enum: ["add", "remove"],
          description: "Whether to add or remove the file",
        },
        filePath: {
          type: "string",
          description: "Path to the file relative to ios/ directory (e.g., 'MyApp/NewFile.swift')",
        },
      },
      required: ["projectPath", "operation", "filePath"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});

async function fetchWithTimeout(url: string, timeout = 10000): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("Fetch error:", error);
    throw error;
  }
}

async function fetchDiffWithCache(
  fromVersion: string,
  toVersion: string
): Promise<string> {
  const cacheKey = `${fromVersion}..${toVersion}`;

  // Check cache first
  if (diffCache.has(cacheKey)) {
    return diffCache.get(cacheKey)!;
  }

  // Fetch from network
  const diffUrl = `https://raw.githubusercontent.com/react-native-community/rn-diff-purge/diffs/diffs/${cacheKey}.diff`;
  const diffContent = await fetchWithTimeout(diffUrl);

  // Cache the result
  diffCache.set(cacheKey, diffContent);

  return diffContent;
}

function parseFilesFromDiff(diffContent: string): string[] {
  const lines = diffContent.split("\n");
  const files: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      if (match) {
        files.push(match[1]);
      }
    }
  }

  return [...new Set(files)];
}

function extractFileDiff(diffContent: string, fileName: string): string {
  const lines = diffContent.split("\n");
  let inFile = false;
  let fileDiff: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Use exact match with word boundaries for the file path
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      if (match && match[1] === fileName) {
        inFile = true;
        fileDiff = [line];
        continue;
      }
    }

    if (inFile) {
      if (line.startsWith("diff --git")) {
        // We've reached the next file, stop here
        break;
      }
      fileDiff.push(line);
    }
  }

  return fileDiff.join("\n");
}

// Extract tool handling logic into a reusable function
async function handleToolCall(name: string, args: any) {
  if (!args) {
    throw new Error("Missing arguments");
  }

  try {
    switch (name) {
      case "get_upgrade_workflow":
        return {
          content: [
            {
              type: "text",
              text: `React Native Upgrade Workflow - Follow this sequence:

STEP 1: Get Current Version
- Call get_current_rn_version with project path

STEP 2: Confirm Target Version  
- Call get_target_version with desired version

STEP 3: Get File List
- Call get_upgrade_diff_files with fromVersion and toVersion
- This returns ALL files that need changes
- Parse the JSON array from "STRUCTURED DATA" section

STEP 4: Create Todo List (RECOMMENDED)
- Call create_upgrade_todo_list with the file array from step 3
- This generates a structured todo list for tracking progress
- IDE should create a todo list with these items for better organization

STEP 5: Process Files ONE BY ONE (CRITICAL)
- For each file in the list:
  1. Call get_file_specific_diff for that single file
  2. If the file is in ios/ directory, call sync_xcode_project if the operation is to add or remove the file first.
  3. Apply the diff to the project file
  4. Verify the changes worked
  5. Move to the next file
- DO NOT try to process multiple files simultaneously
- Complete each file fully before moving to the next

SPECIAL FILE HANDLING:

SCRIPT FILES (gradlew, gradlew.bat):
- Script files like 'gradlew' and 'gradlew.bat' are text files - patch them normally with diff
- These are executable text files, not binary files

BINARY FILES (JAR, images, fonts, native libraries):
- True binary files (.jar, .png, .so, etc.) cannot be patched with diff
- User must manually download/replace these from React Native template
- Provide clear download instructions for each binary file

COMPLEX MIGRATIONS (AppDelegate.mm → AppDelegate.swift):
- DO NOT skip complex file migrations because they seem difficult
- When migrating AppDelegate.mm to AppDelegate.swift (or similar):
  1. Parse the existing .mm file for custom user logic
  2. Identify custom integrations (Firebase, Google Maps, etc.)
  3. Generate the new .swift file with RN template structure
  4. Migrate ALL custom user logic to Swift syntax
  5. Preserve all existing functionality and integrations
- Always perform the complete migration, preserving user customizations

iOS PROJECT SYNC:
- After adding/removing iOS native files, use sync_xcode_project tool
- Operations: 'add' or 'remove'
- File path should be relative to ios/ directory (e.g., 'MyApp/NewFile.swift')
- Tool automatically detects file type based on extension
- After syncing, always run 'cd ios && pod install'
- Always open .xcworkspace (not .xcodeproj) in Xcode

IMPORTANT: Process files sequentially, not in parallel. This ensures proper dependency handling and conflict resolution.`,
            },
          ],
        };

      case "get_current_rn_version": {
        const packageJsonPath = join(
          args.projectPath as string,
          "package.json"
        );

        if (!existsSync(packageJsonPath)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: package.json not found at ${packageJsonPath}`,
              },
            ],
          };
        }

        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        const rnVersion =
          packageJson.dependencies?.["react-native"] ||
          packageJson.devDependencies?.["react-native"];

        if (!rnVersion) {
          return {
            content: [
              {
                type: "text",
                text: "Error: react-native not found in dependencies",
              },
            ],
          };
        }

        const cleanVersion = rnVersion.replace(/[\^~]/, "");

        return {
          content: [
            {
              type: "text",
              text: `Current React Native version: ${cleanVersion}`,
            },
          ],
        };
      }

      case "get_target_version":
        return {
          content: [
            {
              type: "text",
              text: `Target version confirmed: ${args.targetVersion}`,
            },
          ],
        };

      case "get_upgrade_diff_files": {
        const fromVersion = args.fromVersion as string;
        const toVersion = args.toVersion as string;

        try {
          const diffContent = await fetchDiffWithCache(fromVersion, toVersion);
          const files = parseFilesFromDiff(diffContent);

          return {
            content: [
              {
                type: "text",
                text: `Found ${
                  files.length
                } files changed in upgrade from ${fromVersion} to ${toVersion}:\n\n${files.join(
                  "\n"
                )}\n\n--- STRUCTURED DATA ---\nFILES: ${JSON.stringify(
                  files
                )}\n\n--- TODO LIST SUGGESTION ---\nRECOMMENDATION: Create a todo list with these ${
                  files.length
                } files to track upgrade progress. Each file should be a separate todo item to process sequentially.`,
              },
            ],
          };
        } catch (error) {
          console.error("Error fetching diff:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error fetching diff: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }

      case "get_file_specific_diff": {
        const fileName = args.fileName as string;
        const fromVersion = args.fromVersion as string;
        const toVersion = args.toVersion as string;

        try {
          const diffContent = await fetchDiffWithCache(fromVersion, toVersion);
          const fileDiff = extractFileDiff(diffContent, fileName);

          if (!fileDiff) {
            return {
              content: [
                {
                  type: "text",
                  text: `No changes found for file: ${fileName}`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Diff for ${fileName}:\n\n${fileDiff}`,
              },
            ],
          };
        } catch (error) {
          console.error("Error fetching file diff:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error fetching file diff: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            ],
          };
        }
      }

      case "analyze_file_type": {
        const fileName = args.fileName as string;
        const extension = fileName.split(".").pop()?.toLowerCase();
        const baseName = fileName.split("/").pop()?.toLowerCase() || "";

        let fileType = "patchable";
        let instructions = "This file can be patched normally with diff.";

        // Check for script files that can be patched
        const scriptFiles = ["gradlew", "gradlew.bat"];

        // Check for true binary files that user must handle
        const binaryExtensions = [
          "jar",
          "png",
          "jpg",
          "jpeg",
          "gif",
          "ico",
          "ttf",
          "otf",
          "so",
          "a",
          "dylib",
        ];

        if (extension && binaryExtensions.includes(extension)) {
          fileType = "binary_manual";
          instructions = `Binary file (${extension}): User must manually download/replace from React Native template. Provide download instructions to user.`;
        } else if (scriptFiles.includes(baseName)) {
          fileType = "patchable";
          instructions = `Script file: Apply diff normally. These are text files that can be patched despite being executables.`;
        }

        // Check for complex migrations
        const complexMigrations = [
          { from: "AppDelegate.mm", to: "AppDelegate.swift" },
          { from: "AppDelegate.m", to: "AppDelegate.swift" },
          { from: "MainActivity.java", to: "MainActivity.kt" },
        ];

        for (const migration of complexMigrations) {
          if (
            fileName.includes(migration.from) ||
            fileName.includes(migration.to)
          ) {
            fileType = "complex_migration";
            instructions = `Complex migration detected (${migration.from} → ${migration.to}). Parse existing file for custom logic (Firebase, Google Maps, etc.) and migrate ALL customizations. DO NOT skip this migration.`;
            break;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `File Analysis: ${fileName}
              
File Type: ${fileType}
Instructions: ${instructions}

File Categories:
- patchable: Normal diff patching (includes script files like gradlew)
- binary_manual: User must download manually (JAR, images, native libs)
- complex_migration: Requires custom logic migration`,
            },
          ],
        };
      }

      case "create_upgrade_todo_list": {
        const files = args.files as string[];
        const fromVersion = args.fromVersion as string;
        const toVersion = args.toVersion as string;

        const todoItems = files.map((file) => `- [ ] Process file: ${file}`);
        const todoList = todoItems.join("\n");

        return {
          content: [
            {
              type: "text",
              text: `React Native Upgrade Todo List (${fromVersion} → ${toVersion})

${todoList}

INSTRUCTIONS FOR IDE:
1. Create a todo list with these ${files.length} items
2. Process files sequentially, one at a time
3. Mark each item complete after successful processing
4. Use analyze_file_type before processing each file

SUGGESTED TODO FORMAT:
${todoItems.join("\n")}

This todo list helps track progress through the ${
                files.length
              } files that need upgrading.`,
            },
          ],
        };
      }

      case "sync_xcode_project": {
        const projectRoot = args.projectPath as string;
        const operation = args.operation as string;
        const filePath = args.filePath as string; // This should be relative to ios/ directory
        
        const iosPath = join(projectRoot, "ios");
        
        // Check if iOS directory exists
        if (!existsSync(iosPath)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: iOS directory not found at ${iosPath}`,
              },
            ],
          };
        }

        // Find the .xcodeproj directory
        const xcodeProj = readdirSync(iosPath).find(f => f.endsWith('.xcodeproj'));
        if (!xcodeProj) {
          return {
            content: [
              {
                type: "text",
                text: `Error: No .xcodeproj found in ${iosPath}`,
              },
            ],
          };
        }

        const pbxprojPath = join(iosPath, xcodeProj, 'project.pbxproj');
        if (!existsSync(pbxprojPath)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: project.pbxproj not found at ${pbxprojPath}`,
              },
            ],
          };
        }

        try {
          // Parse the project file
          const project = xcode.project(pbxprojPath);
          project.parseSync();

          let result = "";
          
          // The filePath is relative to ios/ directory, just use it directly
          // The xcode package expects paths relative to the project file location
          
          if (operation === "add") {
            // Check if file exists
            const absoluteFilePath = join(iosPath, filePath);
            if (!existsSync(absoluteFilePath)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: File does not exist: ${absoluteFilePath}`,
                  },
                ],
              };
            }

            // Determine file type based on extension
            const ext = filePath.split('.').pop()?.toLowerCase();
            
            // Try to find an existing group to add to (avoid Plugins group which may not exist)
            let groupName = null;
            
            // Try to find the main app group by looking for existing Swift/ObjC files
            const groups = project.hash.project.objects['PBXGroup'];
            for (const groupKey in groups) {
              if (groupKey.includes('_comment')) continue;
              const group = groups[groupKey];
              if (group && group.children && group.children.length > 0) {
                // Check if this group has source files
                const hasSourceFiles = group.children.some((child: any) => {
                  const fileRef = project.hash.project.objects['PBXFileReference'][child.value];
                  if (fileRef && fileRef.path) {
                    const path = fileRef.path.replace(/"/g, '');
                    return path.endsWith('.swift') || path.endsWith('.m') || path.endsWith('.mm');
                  }
                  return false;
                });
                if (hasSourceFiles) {
                  groupName = groupKey;
                  break;
                }
              }
            }
            
            if (ext === 'swift' || ext === 'm' || ext === 'mm' || ext === 'cpp' || ext === 'c') {
              // Source file
              if (groupName) {
                project.addSourceFile(filePath, null, groupName);
              } else {
                // Fallback: create our own group
                const newGroupKey = project.pbxCreateGroup('Sources');
                project.addSourceFile(filePath, null, newGroupKey);
              }
              result = `Added source file: ${filePath}`;
            } else if (ext === 'h' || ext === 'hpp') {
              // Header file
              if (groupName) {
                project.addHeaderFile(filePath, null, groupName);
              } else {
                const newGroupKey = project.pbxCreateGroup('Headers');
                project.addHeaderFile(filePath, null, newGroupKey);
              }
              result = `Added header file: ${filePath}`;
            } else if (ext === 'framework' || ext === 'a' || ext === 'dylib') {
              // Framework or library
              project.addFramework(filePath);
              result = `Added framework: ${filePath}`;
            } else {
              // Resource file (images, xibs, storyboards, etc)
              project.addResourceFile(filePath);
              result = `Added resource file: ${filePath}`;
            }
            
          } else if (operation === "remove") {
            // Normalize the file path - remove ios/ prefix if present
            let normalizedPath = filePath;
            if (filePath.startsWith('ios/')) {
              normalizedPath = filePath.substring(4); // Remove 'ios/' prefix
            }
            
            // Find the file in the project
            let fileFound = false;
            let fileRef: string | null = null;
            let buildFileUuid: string | null = null;
            
            // Search in PBXFileReference section - be very thorough
            const fileRefs = project.pbxFileReferenceSection();
            for (const [uuid, fileRefObj] of Object.entries(fileRefs)) {
              if (uuid.includes('_comment')) continue;
              const refObj = fileRefObj as any;
              if (refObj && (refObj.path || refObj.name)) {
                const refPath = (refObj.path || refObj.name || '').replace(/"/g, ''); // Remove quotes
                const fileName = normalizedPath.split('/').pop();
                
                // Try multiple matching strategies
                if (refPath === normalizedPath || 
                    refPath === fileName ||
                    refPath.endsWith('/' + normalizedPath) ||
                    refPath.endsWith('/' + fileName) ||
                    normalizedPath.endsWith('/' + refPath)) {
                  fileRef = uuid;
                  fileFound = true;
                  break;
                }
              }
            }
            
            if (fileFound && fileRef) {
              // Find corresponding build file
              const buildFiles = project.pbxBuildFileSection();
              for (const [uuid, buildFileObj] of Object.entries(buildFiles)) {
                if (uuid.includes('_comment')) continue;
                const buildFile = buildFileObj as any;
                if (buildFile && buildFile.fileRef === fileRef) {
                  buildFileUuid = uuid;
                  break;
                }
              }
              
              // Use the xcode library's built-in removal methods with fallback
              try {
                const ext = normalizedPath.split('.').pop()?.toLowerCase();
                let removed = false;
                
                // Try the appropriate removal method based on file type
                if (ext === 'swift' || ext === 'm' || ext === 'mm' || ext === 'cpp' || ext === 'c') {
                  try {
                    project.removeSourceFile(normalizedPath);
                    removed = true;
                  } catch (e) {
                    // Try without extension or with different path variants
                    try {
                      const fileName = normalizedPath.split('/').pop();
                      project.removeSourceFile(fileName);
                      removed = true;
                    } catch (e2) {
                      // Fall back to manual removal
                    }
                  }
                } else if (ext === 'h' || ext === 'hpp') {
                  try {
                    project.removeHeaderFile(normalizedPath);
                    removed = true;
                  } catch (e) {
                    try {
                      const fileName = normalizedPath.split('/').pop();
                      project.removeHeaderFile(fileName);
                      removed = true;
                    } catch (e2) {
                      // Fall back to manual removal
                    }
                  }
                } else if (ext === 'framework' || ext === 'a' || ext === 'dylib') {
                  try {
                    project.removeFramework(normalizedPath);
                    removed = true;
                  } catch (e) {
                    // Fall back to manual removal
                  }
                } else {
                  try {
                    project.removeResourceFile(normalizedPath);
                    removed = true;
                  } catch (e) {
                    // Fall back to manual removal
                  }
                }
                
                // If built-in methods failed, do manual removal
                if (!removed) {
                  // Remove from file references
                  delete fileRefs[fileRef];
                  delete fileRefs[fileRef + '_comment'];
                  
                  // Remove from build files if found
                  if (buildFileUuid) {
                    delete buildFiles[buildFileUuid];
                    delete buildFiles[buildFileUuid + '_comment'];
                  }
                  
                  // Remove from build phases
                  const allBuildPhases = [
                    project.hash.project.objects['PBXSourcesBuildPhase'],
                    project.hash.project.objects['PBXResourcesBuildPhase'],
                    project.hash.project.objects['PBXFrameworksBuildPhase']
                  ];
                  
                  for (const buildPhaseSection of allBuildPhases) {
                    if (buildPhaseSection) {
                      for (const phaseKey in buildPhaseSection) {
                        if (phaseKey.includes('_comment')) continue;
                        const phase = buildPhaseSection[phaseKey];
                        if (phase && phase.files && Array.isArray(phase.files)) {
                          phase.files = phase.files.filter((f: any) => f.value !== buildFileUuid);
                        }
                      }
                    }
                  }
                  
                  // Remove from groups
                  const groups = project.hash.project.objects['PBXGroup'];
                  if (groups) {
                    for (const groupKey in groups) {
                      if (groupKey.includes('_comment')) continue;
                      const group = groups[groupKey];
                      if (group && group.children && Array.isArray(group.children)) {
                        group.children = group.children.filter((child: any) => child.value !== fileRef);
                      }
                    }
                  }
                }
                
                result = `Removed file: ${normalizedPath}`;
              } catch (error) {
                result = `Error removing file: ${normalizedPath} - ${error}`;
              }
            } else {
              // Debug: show what files ARE in the project
              const foundFiles: string[] = [];
              for (const [uuid, fileRefObj] of Object.entries(fileRefs)) {
                if (uuid.includes('_comment')) continue;
                const refObj = fileRefObj as any;
                if (refObj && (refObj.path || refObj.name)) {
                  const refPath = (refObj.path || refObj.name || '').replace(/"/g, '');
                  foundFiles.push(refPath);
                }
              }
              result = `File not found in project: ${normalizedPath}\\n\\nFiles in project: ${foundFiles.slice(0, 10).join(', ')}${foundFiles.length > 10 ? '...' : ''}`;
            }
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Unknown operation '${operation}'. Use 'add' or 'remove'.`,
                },
              ],
            };
          }

          // Write the updated project back to disk
          writeFileSync(pbxprojPath, project.writeSync());

          return {
            content: [
              {
                type: "text",
                text: `✅ Xcode Project Updated

${result}

Next Steps:
1. Run 'cd ios && pod install'
2. Open .xcworkspace in Xcode
3. Clean and rebuild (Cmd+Shift+K, then Cmd+B)`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}

Please check:
- File path is relative to ios/ directory
- File exists (for add operation)
- Project structure is valid`,
              },
            ],
          };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error("Tool execution error:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        },
      ],
    };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await handleToolCall(name, args);
});

async function runServer() {
  const transport = new StdioServerTransport();
  console.error("RN Upgrader MCP Server started (stdio)");
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error("Server startup error:", error);
});
