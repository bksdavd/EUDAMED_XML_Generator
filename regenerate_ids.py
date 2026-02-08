import uuid
import datetime
import random
import string
import xml.etree.ElementTree as ET
import os

# --- GS1 GMN Algorithm Implementation ---
class GMN:
    # Descending primes used as multipliers of each data character.
    weights = [83, 79, 73, 71, 67, 61, 59, 53, 47, 43, 41, 37, 31, 29, 23, 19, 17, 13, 11, 7, 5, 3, 2]

    # GS1 AI encodable character set 82.
    cset82 = "!\"%&'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"

    # Subset of the encodable character set used for the check character pair.
    cset32 = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

    # Character to value map for cset82.
    cset82val = {c: i for i, c in enumerate(cset82)}

    # Character to value map for cset32.
    cset32val = {c: i for i, c in enumerate(cset32)}

    @staticmethod
    def check_characters(part):
        min_length = 6
        max_length = len(GMN.weights)
        if len(part) < min_length or len(part) > max_length:
            raise ValueError(f"Input length {len(part)} invalid (must be {min_length}-{max_length})")

        offset = len(GMN.weights) - len(part)
        sum_val = 0
        for i, char in enumerate(part):
            if char not in GMN.cset82val:
                raise ValueError(f"Invalid character: {char}")
            c = GMN.cset82val[char]
            w = GMN.weights[offset + i]
            sum_val += c * w
        
        sum_val %= 1021
        c1 = GMN.cset32[sum_val >> 5]
        c2 = GMN.cset32[sum_val & 31]
        return c1 + c2

def calculate_gs1_basic_udi_check_digits(input_string):
    """
    Calculates 2 check characters using the OFFICIAL GS1 GMN Algorithm.
    (Weighted Modulo 1021)
    """
    return GMN.check_characters(input_string)


def calculate_gtin_check_digit(gtin_without_check):
    """
    Calculates the check digit for a GTIN (Mod 10).
    Input should be the first 13 digits for a GTIN-14.
    """
    if len(gtin_without_check) != 13:
        raise ValueError("GTIN-14 base must be 13 digits")
        
    total = 0
    # Process from right to left (excluding the check digit position)
    # Positions are 1-based index from left: 1, 2, 3... 13
    # Weight is 3 for odd positions, 1 for even positions (assuming 14 total chars)
    # But standard algorithm is: 
    # "Multiply each digit by the weight... position 1 (rightmost, check digit) is excluded"
    # For GTIN-14:
    # Index 0 (Pos 1): *3
    # Index 1 (Pos 2): *1
    # ...
    
    # Let's align with the standard: "Sum of odd index values * 3 + Sum of even index values"
    # (Using 0-based index from the start of the 13-digit string)
    
    for i, digit in enumerate(gtin_without_check):
        n = int(digit)
        if i % 2 == 0: # Even index (0, 2, 4...) -> Odd Position (1st, 3rd...) -> Weight 3
            total += n * 3
        else:          # Odd index (1, 3, 5...) -> Even Position (2nd, 4th...) -> Weight 1
            total += n
            
    remainder = total % 10
    if remainder == 0:
        return "0"
    else:
        return str(10 - remainder)

# --- Main Script ---

def regenerate_ids(input_file, output_file):
    print(f"Reading {input_file}...")
    
    # Register namespaces to preserve prefixes
    namespaces = {
        'm': "https://ec.europa.eu/tools/eudamed/dtx/servicemodel/Message/v1",
        'basicudi': "https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/BasicUDI/v1",
        'commondi': "https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/CommonDevice/v1",
        'device': "https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/v1",
        'udidi': "https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/UDIDI/v1",
        'links': "https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Links/v1",
        'marketinfo': "https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/MktInfo/MarketInfo/v1",
        'ns2': "https://ec.europa.eu/tools/eudamed/dtx/servicemodel/Service/v1"
    }
    
    for prefix, uri in namespaces.items():
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            pass

    tree = ET.parse(input_file)
    root = tree.getroot()

    # 1. Update Envelope IDs
    print("Updating Envelope IDs...")
    
    # Message ID
    msg_id_node = root.find(".//m:messageID", namespaces)
    if msg_id_node is not None:
        new_msg_id = str(uuid.uuid4())
        msg_id_node.text = new_msg_id
    
    # Correlation ID
    corr_id_node = root.find(".//m:correlationID", namespaces)
    if corr_id_node is not None:
        new_corr_id = str(uuid.uuid4())
        corr_id_node.text = new_corr_id
        
    # Creation DateTime
    date_node = root.find(".//m:creationDateTime", namespaces)
    if date_node is not None:
        now_utc = datetime.datetime.utcnow().isoformat(timespec='microseconds') + "Z"
        date_node.text = now_utc

    # 2. Generate new Basic UDI-DI
    print("Generating new Basic UDI-DI...")
    
    # Manufacturer Prefix (from existing data: 599302)
    mf_prefix = "599302" 
    
    # User Request: "Get the modelref suffix from the old file: last six characters of the old file basicudi"
    # Update: User updated the minimal file to 677TAY but script kept pulling 877PAY from the "old" file.
    # Change specific priority:
    # 1. Check Current Input File for a valid suffix (e.g. 677TAY).
    # 2. If not found/valid, Check Old File (Reference).
    
    model_ref_suffix = "877PAY" # Fallback
    suffix_found = False

    # 1. Try Current File
    existing_basic_udi_node = root.find(".//device:MDRBasicUDI/basicudi:identifier/commondi:DICode", namespaces)
    if existing_basic_udi_node is not None and existing_basic_udi_node.text:
         raw_text = existing_basic_udi_node.text.strip()
         # Check if it looks like a valid ID (longer than prefix 6 + suffix 1)
         if len(raw_text) > 8:
             # Heuristic: If it ends in U9 or 2 digits, strip 2.
             # Or just take 599302...[SUFFIX]..XX
             # If prefix is 599302 (len 6). 
             # Is the whole thing the base? Or base+check?
             # Let's assume it *might* have check digits 2 chars.
             potential_base_with_check = raw_text
             potential_base = raw_text[:-2] 
             
             # Extract suffix after 599302
             if potential_base.startswith(mf_prefix):
                 model_ref_suffix = potential_base[len(mf_prefix):]
                 print(f"Extracted suffix '{model_ref_suffix}' from CURRENT file.")
                 suffix_found = True
             elif raw_text.startswith(mf_prefix): # Maybe user didn't have check digits?
                  # If raw text is e.g. 599302677TAY (12 chars) -> suffix is 677TAY
                  # If raw text is 599302677TAY75 -> 
                  pass

             # Strict logic as per previous success:
             # If it ends with known check digits or dummy U9, strip them.
             if not suffix_found and len(raw_text) >= 12: # 6 prefix + min 4 suffix + 2 check
                  model_ref_suffix = raw_text[6:-2]
                  print(f"Extracted suffix '{model_ref_suffix}' from CURRENT file (stripped last 2).")
                  suffix_found = True

    # 2. Try Old File (Only if not found in current)
    if not suffix_found:
        old_file_path = os.path.join(os.path.dirname(input_file), "Test-677TAY.xml")
        if os.path.exists(old_file_path):
            try:
                tree_old = ET.parse(old_file_path)
                root_old = tree_old.getroot()
                old_node = root_old.find(".//device:MDRBasicUDI/basicudi:identifier/commondi:DICode", namespaces)
                if old_node is not None and old_node.text:
                    raw_text = old_node.text.strip()
                    if len(raw_text) > 8:
                        model_ref_suffix = raw_text[:-2][-6:] # Fallback to last 6 of base
                        print(f"Extracted suffix '{model_ref_suffix}' from OLD file: {os.path.basename(old_file_path)}")
                        suffix_found = True
            except Exception as e:
                print(f"Could not read from old file {old_file_path}: {e}")

    new_model_base = f"{mf_prefix}{model_ref_suffix}"
    
    # Calculate GMN Alphanumeric Check Digits (GS1 Official Algorithm)
    try:
        check_digits = calculate_gs1_basic_udi_check_digits(new_model_base)
        print(f"Calculated Check Digits for {new_model_base}: {check_digits}")
    except ValueError as e:
        print(f"Error calculating GS1 check digits: {e}")
        # Fallback to XX if calculation fails (should not happen with valid chars)
        check_digits = "XX"

    
    new_basic_udi = new_model_base + check_digits
    
    # Update Basic UDI-DI in <basicudi:identifier>
    basic_udi_node = root.find(".//device:MDRBasicUDI/basicudi:identifier/commondi:DICode", namespaces)
    if basic_udi_node is not None:
        basic_udi_node.text = new_basic_udi
        
    # Update Model name as well to match
    model_node = root.find(".//device:MDRBasicUDI/basicudi:model", namespaces)
    if model_node is not None:
        model_node.text = f"Test-{model_ref_suffix}"

    # 3. Generate new UDI-DI (GTIN-14)
    print("Generating new UDI-DI (GTIN)...")
    # Prefix: 0599302
    gtin_prefix = "0599302"
    # Need 6 more digits for base 13 (since prefix is 7 chars)
    # Wait, 0 + 599302 + 6 digits = 13 digits.
    random_digits = ''.join(random.choices(string.digits, k=6))
    gtin_base = gtin_prefix + random_digits
    
    gtin_check = calculate_gtin_check_digit(gtin_base)
    new_gtin = gtin_base + gtin_check
    
    # Update UDI-DI in <udidi:identifier>
    udidi_node = root.find(".//device:MDRUDIDIData/udidi:identifier/commondi:DICode", namespaces)
    if udidi_node is not None:
        udidi_node.text = new_gtin
        
    # Also update referenceNumber to match GTIN (common practice)
    ref_node = root.find(".//device:MDRUDIDIData/udidi:referenceNumber", namespaces)
    if ref_node is not None:
        ref_node.text = new_gtin

    # 4. Link UDIData to the new Basic UDI
    print("Linking UDI-DI to new Basic UDI-DI...")
    link_node = root.find(".//device:MDRUDIDIData/udidi:basicUDIIdentifier/commondi:DICode", namespaces)
    if link_node is not None:
        link_node.text = new_basic_udi

    # Save
    tree.write(output_file, encoding="utf-8", xml_declaration=True)
    
    # Post-processing to ensure ns2 prefix is used instead of s
    with open(output_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Replace any stray s: prefixes for the service namespace if they exist (and ensure definition matches)
    # The read_file showed xmlns:ns2 defined but tags using s:. 
    # We replace s: tags with ns2: tags.
    # Note: simple string replacement might be dangerous if 's:' appears in data, 
    # but for this specific XML structure and limited scope, it's likely safe enough or we can be more specific.
    
    if '<s:' in content or '</s:' in content:
        print("  Patched 's:' prefixes to 'ns2:'...")
        content = content.replace('<s:', '<ns2:')
        content = content.replace('</s:', '</ns2:')
        
        # If xmlns:s exists, replace it, but we saw xmlns:ns2 in the output.
        # Just in case:
        content = content.replace('xmlns:s=', 'xmlns:ns2=')
        
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f"Done! New file saved to: {output_file}")
    print(f"New Basic UDI-DI: {new_basic_udi}")
    print(f"New UDI-DI (GTIN): {new_gtin}")

if __name__ == "__main__":
    input_xml = r"k:\PMO Projects\24_01_E New ERP Introduction\Migration\EUDAMED\MC Example XMLs\DEVICE POST\Test-677TAY_minimal.xml"
    output_xml = r"k:\PMO Projects\24_01_E New ERP Introduction\Migration\EUDAMED\MC Example XMLs\DEVICE POST\Test-677TAY_minimal_new.xml"
    
    if os.path.exists(input_xml):
        regenerate_ids(input_xml, output_xml)
    else:
        print(f"Error: Input file not found: {input_xml}")
