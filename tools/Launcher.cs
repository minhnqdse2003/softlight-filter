using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// ============================================================================
//  softlight.exe — cau noi giua dslrBooth va bo xu ly Node.
//
//  DAY CHI LA CAU NOI ~6KB, KHONG PHAI CHUONG TRINH.
//  No can co ben canh: src\cli.js, node_modules\, softlight.config.json,
//  va mot ban Node.js de chay. Chep rieng file exe sang may khac se khong
//  chay duoc. Vi vay moi nhanh that bai o day deu phai ghi log noi ro thieu gi
//  — chay o che do winexe nen khong co cua so nao de bao loi.
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

        if (!File.Exists(script))
        {
            Log(dir, "THIEU src\\cli.js canh softlight.exe. File exe chi la cau noi 6KB; "
                   + "phai chep CA THU MUC (src, node_modules, softlight.config.json), "
                   + "khong the chep rieng file exe. Dang tim tai: " + script);
            return 0;
        }
        if (!Directory.Exists(Path.Combine(dir, "node_modules")))
        {
            Log(dir, "THIEU thu muc node_modules. Chay 'npm install' trong thu muc nay, "
                   + "hoac chep ca thu muc node_modules tu may goc sang.");
            return 0;
        }

        string node = ResolveNode(dir);

        var cmd = new StringBuilder();
        cmd.Append(Quote(script));
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
                    Log(dir, "node chay qua " + TimeoutMs + "ms nen da bi dung.");
                }
                else if (p.ExitCode != 0 || err.Trim().Length > 0)
                {
                    // Day la nhanh tung im lang: node bao loi ra stderr roi thoat,
                    // khong co ngoai le nao duoc nem ra nen truoc kia khong ai biet.
                    Log(dir, "node thoat voi ma " + p.ExitCode + ". stderr: " + Squash(err));
                }
            }
        }
        catch (Exception ex)
        {
            Log(dir, "khong chay duoc Node (" + node + "): " + ex.Message
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

    static void Log(string dir, string msg)
    {
        try
        {
            string logDir = Path.Combine(dir, "logs");
            Directory.CreateDirectory(logDir);
            File.AppendAllText(
                Path.Combine(logDir, "softlight.log"),
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
