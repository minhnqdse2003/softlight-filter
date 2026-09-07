using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// ============================================================================
//  <id>.exe — cau noi giua dslrBooth va bo xu ly Node.
//
//  DAY CHI LA CAU NOI ~6KB, KHONG PHAI CHUONG TRINH.
//  No can co ben canh: src\cli.js, node_modules\, <id>.config.json,
//  va mot ban Node.js de chay. Chep rieng file exe sang may khac se khong
//  chay duoc. Vi vay moi nhanh that bai o day deu phai ghi log noi ro thieu gi
//  — chay o che do winexe nen khong co cua so nao de bao loi.
//
//  MOT NGUON, NHIEU EXE. File nay duoc bien dich ra nhieu ban co ten khac
//  nhau — softlight.exe, instax.exe — va MOI BAN TU BIET no phai chay bo loc
//  nao bang cach doc chinh ten file cua no. Nho vay them mot bo loc moi chi
//  la them mot dong trong build-exe.bat, khong phai viet lai launcher; va
//  moi bo loc co file cau hinh, file log rieng nen chay canh nhau khong dung
//  do gi cua nhau.
//
//  Vi sao la .exe chu khong phai .bat:
//   1) Muc Post-Processing cua dslrBooth chon file thuc thi.
//   2) File .bat chay qua cmd.exe, ma cmd PHAN TICH LAI dong lenh; tham so
//      chua ky tu | se bi hieu thanh toan tu pipe va lam vo lenh, ngay truoc
//      khi .bat kip chay. Tien trinh nay nhan argv truc tiep, khong qua shell.
//   3) /target:winexe nen khong nhay cua so console moi lan chup.
//
//  Bien dich: build-exe.bat
// ============================================================================

static class Launcher
{
    // Chan tren de mot lan xu ly treo khong lam dslrBooth dung hinh mai.
    const int TimeoutMs = 60000;

    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(dir, "src\\cli.js");

        // Ten file exe = id bo loc. FriendlyName tra ve "instax.exe" ke ca khi
        // nguoi dung doi ten file, nen doi ten exe la doi bo loc — dung y do.
        string id = Path.GetFileNameWithoutExtension(
                        AppDomain.CurrentDomain.FriendlyName).ToLowerInvariant();
        if (id.Length == 0) id = "softlight";

        if (!File.Exists(script))
        {
            Log(dir, id, "THIEU src\\cli.js canh " + id + ".exe. File exe chi la cau noi 6KB; "
                   + "phai chep CA THU MUC (src, node_modules, " + id + ".config.json), "
                   + "khong the chep rieng file exe. Dang tim tai: " + script);
            return 0;
        }
        if (!Directory.Exists(Path.Combine(dir, "node_modules")))
        {
            Log(dir, id, "THIEU thu muc node_modules. Chay 'npm install' trong thu muc nay, "
                   + "hoac chep ca thu muc node_modules tu may goc sang.");
            return 0;
        }

        string node = ResolveNode(dir);

        var cmd = new StringBuilder();
        cmd.Append(Quote(script));
        // Co --filter di truoc moi tham so cua dslrBooth. cli.js boc no ra
        // truoc khi phan tich phan con lai, nen no khong the bi nham voi mot
        // duong dan anh hay mot ten su kien.
        cmd.Append(" --filter ").Append(Quote(id));
        foreach (string a in args) { cmd.Append(' '); cmd.Append(Quote(a)); }

        try
        {
            var psi = new ProcessStartInfo(node, cmd.ToString())
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = dir,
                RedirectStandardError = true,
            };

            using (Process p = Process.Start(psi))
            {
                // Doc het stderr TRUOC WaitForExit. Neu doi nguoc lai, tien trinh
                // con co the day day bo dem duong ong va treo — con day chi mot
                // luong duoc chuyen huong nen doc thang la an toan.
                string err = p.StandardError.ReadToEnd();

                if (!p.WaitForExit(TimeoutMs))
                {
                    try { p.Kill(); } catch { }
                    Log(dir, id, "node chay qua " + TimeoutMs + "ms nen da bi dung.");
                }
                else if (p.ExitCode != 0 || err.Trim().Length > 0)
                {
                    // Day la nhanh tung im lang: node bao loi ra stderr roi thoat,
                    // khong co ngoai le nao duoc nem ra nen truoc kia khong ai biet.
                    Log(dir, id, "node thoat voi ma " + p.ExitCode + ". stderr: " + Squash(err));
                }
            }
        }
        catch (Exception ex)
        {
            Log(dir, id, "khong chay duoc Node (" + node + "): " + ex.Message
                   + " | Kiem tra Node.js da cai chua (node -v), hoac tao file "
                   + "node-path.txt canh exe chua duong dan day du toi node.exe.");
        }

        // Luon tra 0. Mot su co hau ky khong duoc phep lam gian doan phien chup
        // cua khach, va dslrBooth van con anh goc de dung tiep.
        return 0;
    }

    /// Thu tu tim Node:
    ///   1. node-path.txt canh exe  — chi dinh tay
    ///   2. <thu muc>\node\node.exe — Node xach tay di kem, khong phu thuoc may
    ///   3. node.exe trong PATH     — Node cai san tren may
    static string ResolveNode(string dir)
    {
        string cfg = Path.Combine(dir, "node-path.txt");
        if (File.Exists(cfg))
        {
            string s = File.ReadAllText(cfg).Trim();
            if (s.Length > 0) return s;
        }

        string bundled = Path.Combine(dir, "node\\node.exe");
        if (File.Exists(bundled)) return bundled;

        return "node.exe";
    }

    static string Squash(string s)
    {
        s = s.Replace("\r", " ").Replace("\n", " ").Trim();
        return s.Length > 600 ? s.Substring(0, 600) + "…" : s;
    }

    /// Log rieng cho tung bo loc: logs\<id>.log, dung file ma cli.js ghi vao.
    static void Log(string dir, string id, string msg)
    {
        try
        {
            string logDir = Path.Combine(dir, "logs");
            Directory.CreateDirectory(logDir);
            File.AppendAllText(
                Path.Combine(logDir, id + ".log"),
                "{\"t\":\"" + DateTime.UtcNow.ToString("o") + "\",\"ev\":\"launcher\",\"error\":\""
                    + msg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}\n",
                new UTF8Encoding(false));
        }
        catch { }
    }

    /// Dat dau nhay cho mot tham so theo dung quy tac CommandLineToArgvW cua Windows.
    /// Phai tu lam vi .NET Framework 4 chua co ProcessStartInfo.ArgumentList.
    static string Quote(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return s;

        var sb = new StringBuilder("\"");
        for (int i = 0; i < s.Length; i++)
        {
            int slashes = 0;
            while (i < s.Length && s[i] == '\\') { slashes++; i++; }

            if (i == s.Length) { sb.Append('\\', slashes * 2); break; }
            if (s[i] == '"') { sb.Append('\\', slashes * 2 + 1).Append('"'); }
            else { sb.Append('\\', slashes).Append(s[i]); }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
