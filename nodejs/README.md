# EUDAMED XML Generator (Node.js)

This tool generates EUDAMED XML files based on YAML configuration and XSD Schema.

## Prerequisites

- Node.js (v14+)
- npm

## Usage

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the generator:

   ```bash
   node index.js --config "path/to/config.yaml" --out "output" --type "BasicUDI" --mode "POST"
   ```

   Arguments:
   - `-c, --config`: Path to the YAML configuration file (e.g., `EUDAMED_data_Lens_877PAY.yaml`).
   - `-s, --schema`: Path to `Message.xsd` (default: `../EUDAMED downloaded/XSD/service/Message.xsd`).
   - `-o, --out`: Output directory.
   - `--type`: Type of XML to generate: `BasicUDI`, `UDIDI`, or `All`.
   - `--mode`: `POST` or `PATCH`.

## Logic

- The tool parses the XSD to understand the structure of the EUDAMED message.
- It recursively traverses the structure starting from `Push`.
- For each element, it checks the YAML configuration (under `defaults`) for a value at the corresponding path.
- It validates the structure implicitly by following the XSD.
- It generates XML files in the output directory.

## Validation

The generator uses the XSD to drive the creation. If the XSD requires structure that is missing in the Config, it might skip it (if optional) or produce a partial XML.
Strict content validation (regex patterns) is partially supported through XSD simpleType checks (future enhancement).

## Project Structure

- `index.js`: Main CLI entry point.
- `lib/schema.js`: XSD Parser and Context Loader.
- `lib/generator.js`: XML Generation Logic.
