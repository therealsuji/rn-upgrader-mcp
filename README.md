# RN Upgrader MCP

A Model Context Protocol (MCP) server for React Native project upgrading. This tool provides structured assistance for upgrading React Native projects by fetching upgrade diffs from the [rn-diff-purge](https://github.com/react-native-community/rn-diff-purge) repository and providing step-by-step guidance.

**⚠️ Important**: This tool automates the application of upgrade diffs, but developers should always validate and test the changes before deploying. Review all modifications to ensure they work correctly with your specific project configuration and custom code.

**📱 Xcode Project Sync**: The Xcode project synchronization feature is still experimental and can be finicky. Always double-check your Xcode project structure after automated changes. If needed, you can manually use the `sync_xcode_project` tool to add or remove specific files from your iOS project.

## Features

- **Version Detection**: Automatically detect current React Native version from package.json
- **Upgrade Workflow**: Get complete step-by-step upgrade workflows
- **Diff Analysis**: Fetch and analyze upgrade diffs between React Native versions
- **File Processing**: Process upgrade files one by one with proper sequencing
- **Xcode Integration**: Automatically sync iOS native files with Xcode project
- **Binary File Handling**: Detect and provide instructions for binary files that require manual handling
- **Complex Migrations**: Handle complex file migrations like AppDelegate.mm to AppDelegate.swift

## Installation

### Prerequisites

- Node.js 18 or higher
- Bun (recommended) or npm

### Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd rn-upgrader-mcp
```

2. Install dependencies:
```bash
bun install
# or
npm install
```

3. Build the project:
```bash
bun run build
# or
npm run build
```

## Usage

### Development Mode

Run the server in development mode with auto-reload:

```bash
bun run dev
```

### Production Mode

Build and start the server:

```bash
bun run build
bun run start
```

## MCP Tools

The server provides the following MCP tools:

### Core Workflow Tools

- **`get_upgrade_workflow`**: Get the complete step-by-step workflow for React Native upgrades
- **`get_current_rn_version`**: Detect current React Native version from package.json
- **`get_target_version`**: Confirm target React Native version

### Diff Processing Tools

- **`get_upgrade_diff_files`**: Get list of all files that need changes in an upgrade
- **`get_file_specific_diff`**: Get the specific diff for a single file
- **`analyze_file_type`**: Analyze file type (patchable, binary, complex migration)

### Project Management Tools

- **`create_upgrade_todo_list`**: Generate structured todo list for upgrade files
- **`sync_xcode_project`**: Add or remove files from Xcode project

## Configuration

### MCP Client Configuration

Add this server to your MCP client configuration (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "rn-upgrader": {
      "command": "node",
      "args": ["/path/to/rn-upgrader-mcp/dist/index.js"]
    }
  }
}
```

### Environment

The server uses stdio transport and requires:
- Internet connection to fetch diffs from GitHub
- Read/write access to React Native project files
- Access to Xcode project files for iOS sync operations

## Upgrade Workflow

The recommended upgrade workflow using this MCP server:

1. **Get Workflow**: Call `get_upgrade_workflow` for complete instructions
2. **Detect Version**: Use `get_current_rn_version` with your project path
3. **Set Target**: Confirm target version with `get_target_version`
4. **Get File List**: Use `get_upgrade_diff_files` to get all files needing changes
5. **Create Todo List**: Use `create_upgrade_todo_list` for organized tracking
6. **Process Files**: For each file:
   - Use `analyze_file_type` to understand handling requirements
   - Use `get_file_specific_diff` to get the specific changes
   - Apply the diff or follow special instructions
   - Use `sync_xcode_project` for iOS native files

## File Types

The server handles different file types appropriately:

- **Patchable Files**: Normal text files that can be patched with diff (includes script files like gradlew)
- **Binary Files**: Files requiring manual download (.jar, images, native libraries)
- **Complex Migrations**: Files requiring custom logic migration (e.g., AppDelegate.mm → AppDelegate.swift)

## Dependencies

- **@modelcontextprotocol/sdk**: MCP SDK for server implementation
- **xcode**: Xcode project file manipulation
- **Node.js built-ins**: File system operations and path utilities

## Development

### Project Structure

```
src/
├── index.ts          # Main MCP server implementation
└── xcode.d.ts        # TypeScript definitions for xcode package

dist/                 # Built output
package.json          # Dependencies and scripts
tsconfig.json         # TypeScript configuration
```

### Building

The project uses TypeScript and is built using Bun:

```bash
bun build src/index.ts --outdir dist --target node --external @modelcontextprotocol/sdk --external xcode
```

### Type Definitions

Custom TypeScript definitions are provided for the `xcode` package in `xcode.d.ts`.

## License

[License information would go here]

## Contributing

[Contribution guidelines would go here]